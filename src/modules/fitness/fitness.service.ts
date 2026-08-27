import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import type { PostVisibility, FitnessShareType, FitnessActivityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FitnessStravaService } from './fitness-strava.service';
import { FitnessIngestService, toNullableJson } from './fitness-ingest.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import type {
  FitnessConnectionDto,
  FitnessActivityDto,
  FitnessActivityDetailDto,
  FitnessDailySummaryDto,
  FitnessBodyMetricDto,
  FitnessGoalDto,
  FitnessSharePreviewDto,
  FitnessShareSnapshotDto,
  FitnessPageDto,
  FitnessWeekSummaryDto,
} from '../../common/dto/fitness.dto';
import { toPostDto } from '../posts/post.dto';
import { vo2maxShareSnapshot } from './fitness-share-snapshot';
import { stravaRawIsComplete } from './fitness-strava.service';
import type { Prisma } from '@prisma/client';

const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
/** Re-fetch recent Strava activities so a late upload after lastSyncAt is not skipped. */
const STRAVA_INCREMENTAL_LOOKBACK_SEC = 48 * 60 * 60;
const RECENT_ACTIVITIES_LIMIT = 100;
const STRAVA_ENRICH_PER_SYNC = 20;
const STRAVA_ENRICH_CONCURRENCY = 2;
const WEIGHT_HISTORY_LIMIT = 60;
const VO2MAX_HISTORY_LIMIT = 60;

function toConnectionDto(conn: {
  provider: string;
  status: string;
  lastSyncAt: Date | null;
  lastManualSyncAt: Date | null;
  providerUserId: string | null;
}): FitnessConnectionDto {
  return {
    provider: conn.provider as any,
    status: conn.status,
    lastSyncAt: conn.lastSyncAt?.toISOString() ?? null,
    lastManualSyncAt: conn.lastManualSyncAt?.toISOString() ?? null,
    providerUserId: conn.providerUserId,
  };
}

function toActivityDto(a: {
  id: string;
  provider: string;
  activityType: FitnessActivityType;
  name?: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number;
  distanceM: number | null;
  effortScore: number | null;
  stepsCount: number | null;
  calories: number | null;
  avgHeartrate: number | null;
  maxHeartrate: number | null;
  totalElevationM: number | null;
}): FitnessActivityDto {
  return {
    id: a.id,
    provider: a.provider as any,
    activityType: a.activityType,
    name: a.name ?? null,
    startedAt: a.startedAt.toISOString(),
    endedAt: a.endedAt?.toISOString() ?? null,
    durationSec: a.durationSec,
    distanceM: a.distanceM,
    effortScore: a.effortScore,
    stepsCount: a.stepsCount,
    calories: a.calories,
    avgHeartrate: a.avgHeartrate,
    maxHeartrate: a.maxHeartrate,
    totalElevationM: a.totalElevationM,
  };
}

function isStravaRateLimit(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 429);
}

function toSummaryDto(s: {
  dayKey: string;
  stepsCount: number | null;
  workoutMinutes: number | null;
  distanceM: number | null;
  effortScore: number | null;
  sleepMinutes?: number | null;
  hrvMs?: number | null;
}, isPremium: boolean): FitnessDailySummaryDto {
  const dto: FitnessDailySummaryDto = {
    dayKey: s.dayKey,
    stepsCount: s.stepsCount,
    workoutMinutes: s.workoutMinutes,
    distanceM: s.distanceM,
    effortScore: s.effortScore,
  };
  if (isPremium) {
    dto.sleepMinutes = s.sleepMinutes ?? null;
    dto.hrvMs = s.hrvMs ?? null;
  }
  return dto;
}

@Injectable()
export class FitnessService {
  private readonly logger = new Logger(FitnessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strava: FitnessStravaService,
    private readonly ingest: FitnessIngestService,
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
  ) {}

  // ─── Page ────────────────────────────────────────────────────────────────────

  async getPage(userId: string): Promise<FitnessPageDto> {
    const healedDates = await this.ingest.healSelfHiddenActivities(userId);
    if (healedDates.length > 0) {
      await this.ingest.rebuildDailySummaries(userId, healedDates);
    }

    const [user, connections, recentActivities, weekSummaries, weightRows, vo2maxRows, activeGoalRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true, fitnessUnits: true, featureToggles: true } }),
      this.prisma.fitnessConnection.findMany({ where: { userId }, select: { provider: true, status: true, lastSyncAt: true, lastManualSyncAt: true, providerUserId: true } }),
      this.prisma.fitnessActivity.findMany({
        where: { userId, dedupedFromId: null },
        orderBy: { startedAt: 'desc' },
        take: RECENT_ACTIVITIES_LIMIT,
        select: { id: true, provider: true, activityType: true, name: true, startedAt: true, endedAt: true, durationSec: true, distanceM: true, effortScore: true, stepsCount: true, calories: true, avgHeartrate: true, maxHeartrate: true, totalElevationM: true },
      }),
      this.getWeekSummaries(userId),
      this.prisma.fitnessBodyMetric.findMany({
        where: { userId, kind: 'weight' },
        orderBy: { measuredAt: 'desc' },
        take: WEIGHT_HISTORY_LIMIT,
        select: { id: true, kind: true, weightKg: true, measuredAt: true, source: true },
      }),
      this.prisma.fitnessBodyMetric.findMany({
        where: { userId, kind: 'vo2max' },
        orderBy: { measuredAt: 'desc' },
        take: VO2MAX_HISTORY_LIMIT,
        select: { id: true, kind: true, weightKg: true, measuredAt: true, source: true },
      }),
      this.prisma.fitnessGoal.findFirst({ where: { userId, kind: 'weight', completedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);

    const isPremium = Boolean(user?.premium || user?.premiumPlus);
    const units = user?.fitnessUnits ?? 'us';

    const weekDays = weekSummaries.days;
    const totalEffort = weekDays.reduce((s, d) => s + (d.effortScore ?? 0), 0);
    const weekSummary: FitnessWeekSummaryDto = {
      ...weekSummaries,
      totalEffort: Math.round(totalEffort),
      activityCount: weekDays.filter((d) => (d.workoutMinutes ?? 0) > 0).length,
      days: weekDays.map((d) => toSummaryDto(d, isPremium)),
    };

    const toMetricDto = (m: { id: string; kind: string; weightKg: number; measuredAt: Date; source: string }): FitnessBodyMetricDto => ({
      id: m.id,
      kind: m.kind,
      weightKg: m.weightKg,
      measuredAt: m.measuredAt.toISOString(),
      source: m.source,
    });

    const stravaEnabled = Boolean(user?.featureToggles?.includes('fitnessStrava'));

    return {
      connections: connections.map(toConnectionDto),
      weekSummary,
      recentActivities: recentActivities.map(toActivityDto),
      units,
      stravaEnabled,
      latestWeight: weightRows[0] ? toMetricDto(weightRows[0]) : null,
      weightHistory: weightRows.map(toMetricDto),
      latestVo2Max: vo2maxRows[0] ? toMetricDto(vo2maxRows[0]) : null,
      vo2maxHistory: vo2maxRows.map(toMetricDto),
      activeGoal: activeGoalRow
        ? { id: activeGoalRow.id, kind: activeGoalRow.kind, startKg: activeGoalRow.startKg, targetKg: activeGoalRow.targetKg, startedAt: activeGoalRow.startedAt.toISOString(), completedAt: activeGoalRow.completedAt?.toISOString() ?? null }
        : null,
    };
  }

  private async getWeekSummaries(userId: string) {
    // Use UTC date arithmetic throughout so that the "Sunday" boundary never
    // shifts to Monday for users in negative UTC offsets (e.g. UTC-4 at 10 PM
    // local = UTC next day, which would produce a Monday ISO string if we mix
    // local setDate() with UTC toISOString()).
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const dowUtc = new Date(todayUtc).getUTCDay(); // 0 = Sunday
    const weekStartMs = todayUtc - dowUtc * 86_400_000;

    const days: string[] = [];
    for (let i = 0; i < 7; i++) {
      days.push(new Date(weekStartMs + i * 86_400_000).toISOString().slice(0, 10));
    }
    const weekStart = { toISOString: () => new Date(weekStartMs).toISOString() };
    const weekEnd = { toISOString: () => new Date(weekStartMs + 6 * 86_400_000).toISOString() };

    const summaries = await this.prisma.fitnessDailySummary.findMany({
      where: { userId, dayKey: { in: days } },
    });

    const summaryMap = new Map(summaries.map((s) => [s.dayKey, s]));
    const filledDays = days.map((dayKey) => summaryMap.get(dayKey) ?? {
      dayKey, stepsCount: null, workoutMinutes: null, distanceM: null, effortScore: null, sleepMinutes: null, hrvMs: null,
    });

    return {
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: weekEnd.toISOString().slice(0, 10),
      totalSteps: filledDays.reduce((s, d) => s + (d.stepsCount ?? 0), 0),
      totalWorkoutMinutes: filledDays.reduce((s, d) => s + (d.workoutMinutes ?? 0), 0),
      totalDistanceM: filledDays.reduce((s, d) => s + (d.distanceM ?? 0), 0),
      days: filledDays,
    };
  }

  // ─── Strava OAuth ─────────────────────────────────────────────────────────────

  getStravaAuthUrl(userId: string, redirectUri: string): string {
    return this.strava.getAuthorizationUrl(userId, redirectUri);
  }

  async connectStrava(userId: string, code: string): Promise<FitnessConnectionDto> {
    const tokens = await this.strava.exchangeCode(code);

    await this.prisma.fitnessConnection.upsert({
      where: { userId_provider: { userId, provider: 'strava' } },
      create: {
        userId,
        provider: 'strava',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: new Date(tokens.expiresAt * 1000),
        providerUserId: String(tokens.athleteId),
        status: 'active',
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: new Date(tokens.expiresAt * 1000),
        providerUserId: String(tokens.athleteId),
        status: 'active',
        lastError: null,
      },
    });

    // Kick off an initial sync.
    void this.syncStrava(userId).catch((err) => this.logger.error(`Initial Strava sync error: ${err}`));

    const conn = await this.prisma.fitnessConnection.findUnique({
      where: { userId_provider: { userId, provider: 'strava' } },
      select: { provider: true, status: true, lastSyncAt: true, lastManualSyncAt: true, providerUserId: true },
    });

    return toConnectionDto(conn!);
  }

  async disconnectStrava(userId: string): Promise<void> {
    // Purge data first; then deauthorize and remove the connection.
    // Purge is best-effort — a failure there must not prevent the disconnect itself.
    await this.purgeProviderData(userId, 'strava').catch((err) =>
      this.logger.error(`purgeProviderData(strava) failed for ${userId}: ${err}`),
    );
    await this.strava.deauthorize(userId);
    await this.prisma.fitnessConnection.deleteMany({ where: { userId, provider: 'strava' } });
  }

  async disconnectAppleHealth(userId: string): Promise<void> {
    await this.purgeProviderData(userId, 'apple_health').catch((err) =>
      this.logger.error(`purgeProviderData(apple_health) failed for ${userId}: ${err}`),
    );
    await this.prisma.fitnessConnection.deleteMany({ where: { userId, provider: 'apple_health' } });
  }

  /**
   * Deletes all activities and body metrics from the given provider, restores any
   * other-provider activities that were hidden behind a dedup, and rebuilds daily
   * summaries for the affected days.
   */
  private async purgeProviderData(userId: string, provider: 'strava' | 'apple_health'): Promise<void> {
    // 1. Collect dates of activities being removed (for summary rebuild).
    const toDelete = await this.prisma.fitnessActivity.findMany({
      where: { userId, provider },
      select: { startedAt: true },
    });
    const dates = toDelete.map((a) => a.startedAt);

    // 2. Un-deduplicate surviving activities from other providers that were hidden
    //    behind this provider's activities. `dedupedFromProvider` tracks which provider
    //    "won" the dedup — clear it so these records become visible again.
    await this.prisma.fitnessActivity.updateMany({
      where: { userId, dedupedFromProvider: provider },
      data: { dedupedFromId: null, dedupedFromProvider: null },
    });

    // 3. Delete the provider's activities.
    await this.prisma.fitnessActivity.deleteMany({ where: { userId, provider } });

    // 4. Delete the provider's body metrics (weight, VO2 max, etc.).
    await this.prisma.fitnessBodyMetric.deleteMany({ where: { userId, source: provider } });

    // 5. Rebuild daily summaries for affected days.
    if (dates.length > 0) {
      await this.ingest.rebuildDailySummaries(userId, dates, { resetSteps: true });
    }
  }

  async syncStrava(userId: string, manual = false): Promise<{ inserted: number; deduped: number }> {
    if (manual) {
      const conn = await this.prisma.fitnessConnection.findUnique({
        where: { userId_provider: { userId, provider: 'strava' } },
        select: { lastManualSyncAt: true },
      });
      if (conn?.lastManualSyncAt) {
        const elapsed = Date.now() - conn.lastManualSyncAt.getTime();
        if (elapsed < MANUAL_SYNC_COOLDOWN_MS) {
          const waitSec = Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000);
          throw new BadRequestException(`Please wait ${waitSec} more seconds before syncing again.`);
        }
      }
    }

    const accessToken = await this.strava.refreshTokenIfNeeded(userId);
    if (!accessToken) throw new BadRequestException('Strava connection is not active.');

    const conn = await this.prisma.fitnessConnection.findUnique({
      where: { userId_provider: { userId, provider: 'strava' } },
      select: { lastSyncAt: true },
    });

    const afterTs = conn?.lastSyncAt
      ? Math.max(0, Math.floor(conn.lastSyncAt.getTime() / 1000) - STRAVA_INCREMENTAL_LOOKBACK_SEC)
      : undefined;
    const rawActivities = await this.strava.fetchActivities(accessToken, afterTs);
    const listByExternalId = new Map(rawActivities.map((a) => [String(a.id), a]));
    const normalized = rawActivities.map((a) => this.strava.normalizeActivity(a));
    const result = await this.ingest.upsertActivities(userId, normalized);

    await this.syncStravaProfile(userId, accessToken);
    await this.enrichIncompleteStravaActivities(userId, accessToken, listByExternalId);

    const now = new Date();
    await this.prisma.fitnessConnection.update({
      where: { userId_provider: { userId, provider: 'strava' } },
      data: {
        lastSyncAt: now,
        ...(manual ? { lastManualSyncAt: now } : {}),
        status: 'active',
        lastError: null,
      },
    });

    return result;
  }

  private async syncStravaProfile(userId: string, accessToken: string): Promise<void> {
    const conn = await this.prisma.fitnessConnection.findUnique({
      where: { userId_provider: { userId, provider: 'strava' } },
      select: { providerUserId: true },
    });
    const athleteId = Number(conn?.providerUserId);
    if (!Number.isFinite(athleteId) || athleteId <= 0) return;
    try {
      const profileJson = await this.strava.fetchProfileBundle(accessToken, athleteId);
      await this.prisma.fitnessConnection.update({
        where: { userId_provider: { userId, provider: 'strava' } },
        data: { profileJson: profileJson as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (isStravaRateLimit(err)) return;
      this.logger.warn(`Strava profile fetch failed for ${userId}: ${err}`);
    }
  }

  private async enrichIncompleteStravaActivities(
    userId: string,
    accessToken: string,
    listByExternalId: Map<string, { id: number } & Record<string, unknown>>,
  ): Promise<void> {
    const rows = await this.prisma.fitnessActivity.findMany({
      where: { userId, provider: 'strava' },
      select: { id: true, externalId: true, rawJson: true },
      orderBy: { startedAt: 'desc' },
      take: 200,
    });
    const incomplete = rows.filter((row) => !stravaRawIsComplete(row.rawJson)).slice(0, STRAVA_ENRICH_PER_SYNC);

    for (let i = 0; i < incomplete.length; i += STRAVA_ENRICH_CONCURRENCY) {
      const slice = incomplete.slice(i, i + STRAVA_ENRICH_CONCURRENCY);
      try {
        await Promise.all(slice.map((row) => this.persistStravaEnrichment(accessToken, row, listByExternalId)));
      } catch (err) {
        if (isStravaRateLimit(err)) {
          this.logger.warn(`Strava rate limited while enriching activities for ${userId}; remaining will retry later`);
          return;
        }
        this.logger.warn(`Strava enrich batch failed for ${userId}: ${err}`);
      }
    }
  }

  private async persistStravaEnrichment(
    accessToken: string,
    row: { id: string; externalId: string; rawJson: unknown },
    listByExternalId: Map<string, { id: number } & Record<string, unknown>>,
  ): Promise<void> {
    const listItem = listByExternalId.get(row.externalId) ?? { id: Number(row.externalId) };
    if (!Number.isFinite(listItem.id)) return;
    const raw = await this.strava.enrichActivityRaw(accessToken, listItem as any, row.rawJson);
    const normalized = this.strava.normalizeActivity(listItem as any, raw);
    await this.prisma.fitnessActivity.update({
      where: { id: row.id },
      data: {
        name: normalized.name,
        durationSec: normalized.durationSec,
        distanceM: normalized.distanceM,
        effortScore: normalized.effortScore,
        calories: normalized.calories,
        avgHeartrate: normalized.avgHeartrate,
        maxHeartrate: normalized.maxHeartrate,
        totalElevationM: normalized.totalElevationM,
        rawJson: toNullableJson(normalized.rawJson),
      },
    });
  }

  async getActivity(userId: string, activityId: string): Promise<FitnessActivityDetailDto> {
    const activity = await this.prisma.fitnessActivity.findFirst({
      where: { id: activityId, userId },
    });
    if (!activity) throw new NotFoundException('Activity not found.');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fitnessUnits: true },
    });
    const units = user?.fitnessUnits ?? 'us';

    let raw: unknown = activity.rawJson;
    if (activity.provider === 'strava' && !stravaRawIsComplete(raw)) {
      const accessToken = await this.strava.refreshTokenIfNeeded(userId);
      if (accessToken) {
        try {
          await this.persistStravaEnrichment(
            accessToken,
            { id: activity.id, externalId: activity.externalId, rawJson: activity.rawJson },
            new Map(),
          );
          const refreshed = await this.prisma.fitnessActivity.findFirst({
            where: { id: activity.id, userId },
          });
          if (refreshed) {
            return this.toActivityDetailDto(refreshed, units);
          }
        } catch (err) {
          if (!isStravaRateLimit(err)) {
            this.logger.warn(`On-demand Strava enrich failed for ${activity.id}: ${err}`);
          }
        }
      }
    }

    return this.toActivityDetailDto({ ...activity, rawJson: raw }, units);
  }

  private toActivityDetailDto(activity: {
    id: string;
    provider: string;
    activityType: FitnessActivityType;
    name: string | null;
    startedAt: Date;
    endedAt: Date | null;
    durationSec: number;
    distanceM: number | null;
    effortScore: number | null;
    stepsCount: number | null;
    calories: number | null;
    avgHeartrate: number | null;
    maxHeartrate: number | null;
    totalElevationM: number | null;
    externalId: string;
    rawJson: unknown;
  }, units: 'us' | 'metric'): FitnessActivityDetailDto {
    return {
      ...toActivityDto(activity),
      externalId: activity.externalId,
      units,
      raw: activity.rawJson ?? {
        note: 'Provider raw payload is not stored for this activity yet. Re-sync to attach it.',
        activity: toActivityDto(activity),
        externalId: activity.externalId,
      },
    };
  }

  // ─── HealthKit upload ─────────────────────────────────────────────────────────

  async uploadHealthKit(userId: string, payload: {
    activities?: Array<{
      externalId: string;
      activityType: FitnessActivityType;
      startedAt: string;
      endedAt?: string | null;
      durationSec: number;
      distanceM?: number | null;
      stepsCount?: number | null;
      calories?: number | null;
      avgHeartrate?: number | null;
      maxHeartrate?: number | null;
      totalElevationM?: number | null;
      name?: string | null;
      raw?: unknown;
    }>;
    bodyMetrics?: Array<{ externalId: string; weightKg: number; measuredAt: string }>;
    vo2maxReadings?: Array<{ externalId: string; vo2maxMlKgMin: number; measuredAt: string }>;
    sleepMinutes?: Array<{ dayKey: string; sleepMinutes: number }>;
    hrv?: Array<{ dayKey: string; hrvMs: number }>;
    dailySteps?: Array<{ dayKey: string; stepsCount: number }>;
  }): Promise<{ activitiesInserted: number; activitiesDeduped: number; metricsUpserted: number }> {
    let metricsUpserted = 0;

    const hasAnyData =
      (payload.activities?.length ?? 0) > 0 ||
      (payload.bodyMetrics?.length ?? 0) > 0 ||
      (payload.vo2maxReadings?.length ?? 0) > 0 ||
      (payload.sleepMinutes?.length ?? 0) > 0 ||
      (payload.hrv?.length ?? 0) > 0 ||
      (payload.dailySteps?.length ?? 0) > 0;

    if (hasAnyData) {
      // Ensure HealthKit connection row exists whenever any payload is non-empty,
      // including sleep/HRV/VO2-only syncs that would otherwise leave the user
      // showing "not connected" despite Apple Health being active.
      await this.prisma.fitnessConnection.upsert({
        where: { userId_provider: { userId, provider: 'apple_health' } },
        create: { userId, provider: 'apple_health', status: 'active', lastSyncAt: new Date() },
        update: { lastSyncAt: new Date(), status: 'active' },
      });
    }

    const activities = (payload.activities ?? []).map((a) => ({
      provider: 'apple_health' as const,
      externalId: a.externalId,
      activityType: a.activityType,
      startedAt: new Date(a.startedAt),
      endedAt: a.endedAt ? new Date(a.endedAt) : null,
      durationSec: a.durationSec,
      distanceM: a.distanceM ?? null,
      effortScore: null,
      stepsCount: a.stepsCount ?? null,
      calories: a.calories && a.calories > 0 ? a.calories : null,
      avgHeartrate: a.avgHeartrate && a.avgHeartrate > 0 ? a.avgHeartrate : null,
      maxHeartrate: a.maxHeartrate && a.maxHeartrate > 0 ? a.maxHeartrate : null,
      totalElevationM: a.totalElevationM && a.totalElevationM > 0 ? a.totalElevationM : null,
      name: a.name?.trim() ? a.name.trim() : null,
      rawJson: a.raw ?? {
        source: 'apple_health',
        externalId: a.externalId,
        activityType: a.activityType,
        startedAt: a.startedAt,
        endedAt: a.endedAt ?? null,
        durationSec: a.durationSec,
        distanceM: a.distanceM ?? null,
        stepsCount: a.stepsCount ?? null,
        calories: a.calories ?? null,
        avgHeartrate: a.avgHeartrate ?? null,
        maxHeartrate: a.maxHeartrate ?? null,
        totalElevationM: a.totalElevationM ?? null,
        name: a.name ?? null,
      },
    }));

    const { inserted, deduped } = activities.length > 0
      ? await this.ingest.upsertActivities(userId, activities)
      : { inserted: 0, deduped: 0 };

    for (const bm of payload.bodyMetrics ?? []) {
      await this.ingest.upsertBodyMetric({
        userId,
        kind: 'weight',
        weightKg: bm.weightKg,
        measuredAt: new Date(bm.measuredAt),
        source: 'apple_health',
        externalId: bm.externalId,
      });
      metricsUpserted++;
    }

    for (const v of payload.vo2maxReadings ?? []) {
      await this.ingest.upsertBodyMetric({
        userId,
        kind: 'vo2max',
        weightKg: v.vo2maxMlKgMin,
        measuredAt: new Date(v.measuredAt),
        source: 'apple_health',
        externalId: v.externalId,
      });
      metricsUpserted++;
    }

    // Update daily summaries with sleep/HRV (premium signals).
    for (const s of payload.sleepMinutes ?? []) {
      await this.prisma.fitnessDailySummary.upsert({
        where: { userId_dayKey: { userId, dayKey: s.dayKey } },
        create: { userId, dayKey: s.dayKey, sleepMinutes: s.sleepMinutes },
        update: { sleepMinutes: s.sleepMinutes },
      });
    }
    for (const h of payload.hrv ?? []) {
      await this.prisma.fitnessDailySummary.upsert({
        where: { userId_dayKey: { userId, dayKey: h.dayKey } },
        create: { userId, dayKey: h.dayKey, hrvMs: h.hrvMs },
        update: { hrvMs: h.hrvMs },
      });
    }

    // Daily step totals from HealthKit must land after activity ingest rebuild,
    // otherwise rebuild would overwrite them with workout-only steps.
    if ((payload.dailySteps?.length ?? 0) > 0) {
      await this.ingest.applyDailySteps(userId, payload.dailySteps ?? []);
    }

    return { activitiesInserted: inserted, activitiesDeduped: deduped, metricsUpserted };
  }

  // ─── Body metrics (manual) ────────────────────────────────────────────────────

  async logWeight(userId: string, weightKg: number, measuredAt?: Date): Promise<FitnessBodyMetricDto> {
    const at = measuredAt ?? new Date();
    await this.ingest.upsertBodyMetric({ userId, weightKg, measuredAt: at, source: 'manual' });
    const metric = await this.prisma.fitnessBodyMetric.findFirst({
      where: { userId, source: 'manual', measuredAt: at },
      orderBy: { createdAt: 'desc' },
    });
    return {
      id: metric!.id,
      kind: metric!.kind,
      weightKg: metric!.weightKg,
      measuredAt: metric!.measuredAt.toISOString(),
      source: 'manual',
    };
  }

  async getWeightHistory(userId: string, limit = 30): Promise<FitnessBodyMetricDto[]> {
    const metrics = await this.prisma.fitnessBodyMetric.findMany({
      where: { userId, kind: 'weight' },
      orderBy: { measuredAt: 'desc' },
      take: limit,
    });
    return metrics.map((m) => ({
      id: m.id,
      kind: m.kind,
      weightKg: m.weightKg,
      measuredAt: m.measuredAt.toISOString(),
      source: m.source,
    }));
  }

  // ─── Goals ────────────────────────────────────────────────────────────────────

  async getGoals(userId: string): Promise<FitnessGoalDto[]> {
    const goals = await this.prisma.fitnessGoal.findMany({
      where: { userId, completedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return goals.map((g) => ({
      id: g.id,
      kind: g.kind,
      startKg: g.startKg,
      targetKg: g.targetKg,
      startedAt: g.startedAt.toISOString(),
      completedAt: g.completedAt?.toISOString() ?? null,
    }));
  }

  async upsertWeightGoal(userId: string, params: { startKg?: number; targetKg: number }): Promise<FitnessGoalDto> {
    const existing = await this.prisma.fitnessGoal.findFirst({
      where: { userId, kind: 'weight', completedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    let goal;
    if (existing) {
      goal = await this.prisma.fitnessGoal.update({
        where: { id: existing.id },
        data: { startKg: params.startKg ?? existing.startKg, targetKg: params.targetKg },
      });
    } else {
      goal = await this.prisma.fitnessGoal.create({
        data: { userId, kind: 'weight', startKg: params.startKg ?? null, targetKg: params.targetKg },
      });
    }

    return {
      id: goal.id,
      kind: goal.kind,
      startKg: goal.startKg,
      targetKg: goal.targetKg,
      startedAt: goal.startedAt.toISOString(),
      completedAt: goal.completedAt?.toISOString() ?? null,
    };
  }

  // ─── Units ────────────────────────────────────────────────────────────────────

  async updateUnits(userId: string, units: 'us' | 'metric'): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { fitnessUnits: units } });
  }

  // ─── Share posts ──────────────────────────────────────────────────────────────

  async createSharePost(params: {
    userId: string;
    shareType: FitnessShareType;
    body: string;
    visibility: PostVisibility;
    activityId?: string;
    bodyMetricId?: string;
    goalId?: string;
    r2BaseUrl?: string | null;
  }): Promise<{ post: ReturnType<typeof toPostDto>; fitnessShare: FitnessSharePreviewDto }> {
    const { userId, shareType, body, visibility, activityId, bodyMetricId, goalId, r2BaseUrl } = params;

    const snapshot = await this.buildSnapshot({ userId, shareType, activityId, bodyMetricId, goalId });

    const share = await this.prisma.fitnessShare.create({
      data: { userId, shareType, activityId: activityId ?? null, bodyMetricId: bodyMetricId ?? null, goalId: goalId ?? null, snapshot: snapshot as any },
    });

    const post = await this.prisma.post.create({
      data: {
        userId,
        body: body.trim(),
        kind: 'fitnessShare',
        visibility,
        fitnessShareId: share.id,
      },
      include: {
        user: {
          select: {
            id: true, username: true, name: true, premium: true, premiumPlus: true,
            isOrganization: true, verifiedStatus: true,
            avatarKey: true, avatarUpdatedAt: true, bannedAt: true,
            orgMemberships: { include: { org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } } } },
          },
        },
        media: true,
        mentions: { include: { user: { select: { id: true, username: true, verifiedStatus: true, premium: true, premiumPlus: true, isOrganization: true } } } },
        fitnessShare: true,
      },
    });

    const postDto = toPostDto(post as any, r2BaseUrl ?? null);
    const previewDto: FitnessSharePreviewDto = { id: share.id, shareType, snapshot };

    return { post: postDto, fitnessShare: previewDto };
  }

  private async buildSnapshot(params: {
    userId: string;
    shareType: FitnessShareType;
    activityId?: string;
    bodyMetricId?: string;
    goalId?: string;
  }): Promise<FitnessShareSnapshotDto> {
    const { userId, shareType, activityId, bodyMetricId, goalId } = params;

    if (shareType === 'activity') {
      if (!activityId) throw new BadRequestException('activityId is required for activity share.');
      const activity = await this.prisma.fitnessActivity.findFirst({
        where: { id: activityId, userId },
      });
      if (!activity) throw new NotFoundException('Activity not found.');
      return {
        type: 'activity',
        data: {
          activityType: activity.activityType,
          startedAt: activity.startedAt.toISOString(),
          durationSec: activity.durationSec,
          distanceM: activity.distanceM,
          effortScore: activity.effortScore,
          stepsCount: activity.stepsCount,
          calories: activity.calories,
          avgHeartrate: activity.avgHeartrate,
          maxHeartrate: activity.maxHeartrate,
          totalElevationM: activity.totalElevationM,
        },
      };
    }

    if (shareType === 'weight') {
      const metricId = bodyMetricId ?? null;
      let metric;
      if (metricId) {
        metric = await this.prisma.fitnessBodyMetric.findFirst({
          where: { id: metricId, userId, kind: 'weight' },
        });
      } else {
        metric = await this.prisma.fitnessBodyMetric.findFirst({
          where: { userId, kind: 'weight' },
          orderBy: { measuredAt: 'desc' },
        });
      }
      if (!metric) throw new NotFoundException('No weight data found.');

      const previous = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, kind: 'weight', measuredAt: { lt: metric.measuredAt } },
        orderBy: { measuredAt: 'desc' },
      });

      const deltaKg = previous ? metric.weightKg - previous.weightKg : null;

      return {
        type: 'weight',
        data: {
          weightKg: metric.weightKg,
          measuredAt: metric.measuredAt.toISOString(),
          previousWeightKg: previous?.weightKg ?? null,
          deltaKg,
        },
      };
    }

    if (shareType === 'progress') {
      const goal = goalId
        ? await this.prisma.fitnessGoal.findFirst({ where: { id: goalId, userId } })
        : await this.prisma.fitnessGoal.findFirst({ where: { userId, kind: 'weight', completedAt: null }, orderBy: { createdAt: 'desc' } });
      if (!goal) throw new NotFoundException('No active weight goal found.');

      const currentMetric = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, kind: 'weight' },
        orderBy: { measuredAt: 'desc' },
      });

      return {
        type: 'progress',
        data: {
          startKg: goal.startKg,
          currentKg: currentMetric?.weightKg ?? null,
          targetKg: goal.targetKg,
          startedAt: goal.startedAt.toISOString(),
        },
      };
    }

    if (shareType === 'vo2max') {
      const metricId = bodyMetricId ?? null;
      const latest = metricId
        ? await this.prisma.fitnessBodyMetric.findFirst({
            where: { id: metricId, userId, kind: 'vo2max' },
          })
        : await this.prisma.fitnessBodyMetric.findFirst({
            where: { userId, kind: 'vo2max' },
            orderBy: { measuredAt: 'desc' },
          });
      if (!latest) throw new NotFoundException('No VO2 max data found.');

      const first = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, kind: 'vo2max' },
        orderBy: { measuredAt: 'asc' },
      });

      return vo2maxShareSnapshot({ latest, first });
    }

    throw new BadRequestException(`Unknown shareType: ${shareType}`);
  }

  // ─── Delete (called from account deletion) ────────────────────────────────────

  async hardDeleteUserFitnessData(userId: string): Promise<void> {
    // Delete in FK-safe order.
    await this.prisma.fitnessShare.deleteMany({ where: { userId } });
    await this.prisma.fitnessBodyMetric.deleteMany({ where: { userId } });
    await this.prisma.fitnessGoal.deleteMany({ where: { userId } });
    await this.prisma.fitnessDailySummary.deleteMany({ where: { userId } });
    await this.prisma.fitnessActivity.deleteMany({ where: { userId } });
    await this.prisma.fitnessConnection.deleteMany({ where: { userId } });
  }
}
