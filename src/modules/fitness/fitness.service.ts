import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import type { PostVisibility, FitnessShareType, FitnessActivityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FitnessStravaService } from './fitness-strava.service';
import { FitnessIngestService } from './fitness-ingest.service';
import { AppConfigService } from '../app/app-config.service';
import { RedisService } from '../redis/redis.service';
import type {
  FitnessConnectionDto,
  FitnessActivityDto,
  FitnessDailySummaryDto,
  FitnessBodyMetricDto,
  FitnessGoalDto,
  FitnessSharePreviewDto,
  FitnessShareSnapshotDto,
  FitnessPageDto,
  FitnessWeekSummaryDto,
} from '../../common/dto/fitness.dto';
import { toPostDto } from '../posts/post.dto';

const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const RECENT_ACTIVITIES_LIMIT = 20;
const WEIGHT_HISTORY_LIMIT = 60;

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
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number;
  distanceM: number | null;
  effortScore: number | null;
  stepsCount: number | null;
  calories: number | null;
  avgHeartrate: number | null;
  maxHeartrate: number | null;
}): FitnessActivityDto {
  return {
    id: a.id,
    provider: a.provider as any,
    activityType: a.activityType,
    startedAt: a.startedAt.toISOString(),
    endedAt: a.endedAt?.toISOString() ?? null,
    durationSec: a.durationSec,
    distanceM: a.distanceM,
    effortScore: a.effortScore,
    stepsCount: a.stepsCount,
    calories: a.calories,
    avgHeartrate: a.avgHeartrate,
    maxHeartrate: a.maxHeartrate,
  };
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
    const [user, connections, recentActivities, weekSummaries, weightRows, vo2maxRows, activeGoalRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { premium: true, premiumPlus: true, fitnessUnits: true, featureToggles: true } }),
      this.prisma.fitnessConnection.findMany({ where: { userId }, select: { provider: true, status: true, lastSyncAt: true, lastManualSyncAt: true, providerUserId: true } }),
      this.prisma.fitnessActivity.findMany({
        where: { userId, dedupedFromId: null },
        orderBy: { startedAt: 'desc' },
        take: RECENT_ACTIVITIES_LIMIT,
        select: { id: true, provider: true, activityType: true, startedAt: true, endedAt: true, durationSec: true, distanceM: true, effortScore: true, stepsCount: true, calories: true, avgHeartrate: true, maxHeartrate: true },
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
        take: 20,
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
      await this.ingest.rebuildDailySummaries(userId, dates);
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

    const afterTs = conn?.lastSyncAt ? Math.floor(conn.lastSyncAt.getTime() / 1000) : undefined;
    const rawActivities = await this.strava.fetchActivities(accessToken, afterTs);
    const normalized = rawActivities.map((a) => this.strava.normalizeActivity(a));
    const result = await this.ingest.upsertActivities(userId, normalized);

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
    }>;
    bodyMetrics?: Array<{ externalId: string; weightKg: number; measuredAt: string }>;
    vo2maxReadings?: Array<{ externalId: string; vo2maxMlKgMin: number; measuredAt: string }>;
    sleepMinutes?: Array<{ dayKey: string; sleepMinutes: number }>;
    hrv?: Array<{ dayKey: string; hrvMs: number }>;
  }): Promise<{ activitiesInserted: number; activitiesDeduped: number; metricsUpserted: number }> {
    let metricsUpserted = 0;

    if (payload.activities?.length) {
      // Ensure HealthKit connection row exists.
      await this.prisma.fitnessConnection.upsert({
        where: { userId_provider: { userId, provider: 'apple_health' } },
        create: { userId, provider: 'apple_health', status: 'active' },
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

    if (payload.activities?.length || payload.bodyMetrics?.length) {
      await this.prisma.fitnessConnection.upsert({
        where: { userId_provider: { userId, provider: 'apple_health' } },
        create: { userId, provider: 'apple_health', status: 'active', lastSyncAt: new Date() },
        update: { lastSyncAt: new Date(), status: 'active' },
      });
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
            isOrganization: true, stewardBadgeEnabled: true, verifiedStatus: true,
            avatarKey: true, avatarUpdatedAt: true, bannedAt: true,
            orgMemberships: { include: { org: { select: { id: true, username: true, name: true, avatarKey: true, avatarUpdatedAt: true } } } },
          },
        },
        media: true,
        mentions: { include: { user: { select: { id: true, username: true, verifiedStatus: true, premium: true, premiumPlus: true, isOrganization: true, stewardBadgeEnabled: true } } } },
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
        },
      };
    }

    if (shareType === 'weight') {
      const metricId = bodyMetricId ?? null;
      let metric;
      if (metricId) {
        metric = await this.prisma.fitnessBodyMetric.findFirst({ where: { id: metricId, userId } });
      } else {
        metric = await this.prisma.fitnessBodyMetric.findFirst({ where: { userId }, orderBy: { measuredAt: 'desc' } });
      }
      if (!metric) throw new NotFoundException('No weight data found.');

      const previous = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, measuredAt: { lt: metric.measuredAt } },
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

      const currentMetric = await this.prisma.fitnessBodyMetric.findFirst({ where: { userId }, orderBy: { measuredAt: 'desc' } });

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
