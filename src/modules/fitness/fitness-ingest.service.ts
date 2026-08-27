import { Injectable, Logger } from '@nestjs/common';
import type { FitnessProvider, FitnessActivityType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DEDUP_DISTANCE_TOLERANCE_M = 100;
const DEDUP_DURATION_TOLERANCE_SEC = 60;
const DEDUP_TIME_TOLERANCE_SEC = 5 * 60;

export type NormalizedActivity = {
  provider: FitnessProvider;
  externalId: string;
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
  totalElevationM: number | null;
  name: string | null;
  rawJson: unknown | null;
};

export function buildDedupeKey(a: NormalizedActivity): string {
  const startBucket = Math.floor(a.startedAt.getTime() / (DEDUP_TIME_TOLERANCE_SEC * 1000));
  const durationBucket = Math.floor(a.durationSec / DEDUP_DURATION_TOLERANCE_SEC);
  const distanceBucket = a.distanceM ? Math.floor(a.distanceM / DEDUP_DISTANCE_TOLERANCE_M) : 'x';
  return `${a.activityType}:${startBucket}:${durationBucket}:${distanceBucket}`;
}

/**
 * Same provider + external id is a refresh of one workout, not a cross-source duplicate.
 * Re-syncing used to mark that row as deduped from itself, which hid it from the fitness page.
 */
export function isSameActivity(
  existing: { provider: FitnessProvider; externalId: string },
  incoming: { provider: FitnessProvider; externalId: string },
): boolean {
  return existing.provider === incoming.provider && existing.externalId === incoming.externalId;
}

/**
 * Which provider wins when two sources provide the same activity.
 * Strava > Apple Health: Strava has GPS + Suffer Score; HealthKit may be a double-count from the watch.
 */
const PROVIDER_PRIORITY: Record<FitnessProvider, number> = {
  strava: 10,
  apple_health: 5,
};

export function toNullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function activityPatch(act: NormalizedActivity) {
  return {
    durationSec: act.durationSec,
    distanceM: act.distanceM,
    effortScore: act.effortScore,
    stepsCount: act.stepsCount,
    calories: act.calories,
    avgHeartrate: act.avgHeartrate,
    maxHeartrate: act.maxHeartrate,
    totalElevationM: act.totalElevationM,
    name: act.name,
    rawJson: toNullableJson(act.rawJson),
  };
}

function activityCreateData(userId: string, dedupeKey: string, act: NormalizedActivity) {
  const { rawJson: _rawJson, ...rest } = act;
  return {
    userId,
    dedupeKey,
    ...rest,
    startedAt: act.startedAt,
    rawJson: toNullableJson(act.rawJson),
  };
}

@Injectable()
export class FitnessIngestService {
  private readonly logger = new Logger(FitnessIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rows that lost a dedup to *themselves* (same external id) are invisible on the
   * fitness page (`dedupedFromId: null`). Restore them and return their start dates
   * so daily summaries can be rebuilt.
   */
  async healSelfHiddenActivities(userId: string): Promise<Date[]> {
    const hidden = await this.prisma.fitnessActivity.findMany({
      where: { userId, NOT: { dedupedFromId: null } },
      select: { id: true, startedAt: true, externalId: true, dedupedFromId: true },
    });
    const selfHidden = hidden.filter((row) => row.dedupedFromId === row.externalId);
    if (selfHidden.length === 0) return [];
    await this.prisma.fitnessActivity.updateMany({
      where: { id: { in: selfHidden.map((row) => row.id) } },
      data: { dedupedFromId: null, dedupedFromProvider: null },
    });
    this.logger.warn(
      `Restored ${selfHidden.length} self-hidden fitness activit${selfHidden.length === 1 ? 'y' : 'ies'} for ${userId}`,
    );
    return selfHidden.map((row) => row.startedAt);
  }

  async upsertActivities(
    userId: string,
    activities: NormalizedActivity[],
  ): Promise<{ inserted: number; deduped: number }> {
    const healedDates = await this.healSelfHiddenActivities(userId);
    let inserted = 0;
    let deduped = 0;

    for (const act of activities) {
      const result = await this.upsertOne(userId, act);
      if (result === 'deduped') deduped++;
      else inserted++;
    }

    const dates = [...healedDates, ...activities.map((a) => a.startedAt)];
    if (dates.length > 0) {
      await this.rebuildDailySummaries(userId, dates);
    }

    return { inserted, deduped };
  }

  private async upsertOne(
    userId: string,
    act: NormalizedActivity,
  ): Promise<'inserted' | 'deduped'> {
    const dedupeKey = buildDedupeKey(act);
    const existing = await this.prisma.fitnessActivity.findFirst({
      where: { userId, dedupeKey, dedupedFromId: null },
      select: { id: true, provider: true, externalId: true },
    });

    if (existing && isSameActivity(existing, act)) {
      await this.prisma.fitnessActivity.update({
        where: { id: existing.id },
        data: { dedupeKey, ...activityPatch(act) },
      });
      return 'inserted';
    }

    if (existing) {
      const existingPriority = PROVIDER_PRIORITY[existing.provider] ?? 0;
      const incomingPriority = PROVIDER_PRIORITY[act.provider] ?? 0;
      if (incomingPriority > existingPriority) {
        await this.prisma.fitnessActivity.update({
          where: { id: existing.id },
          data: {
            dedupedFromId: act.externalId,
            dedupedFromProvider: act.provider,
          },
        });
        await this.prisma.fitnessActivity.upsert({
          where: {
            userId_provider_externalId: {
              userId,
              provider: act.provider,
              externalId: act.externalId,
            },
          },
          create: activityCreateData(userId, dedupeKey, act),
          update: { dedupeKey, ...activityPatch(act), dedupedFromId: null, dedupedFromProvider: null },
        });
        return 'inserted';
      }

      await this.prisma.fitnessActivity.upsert({
        where: {
          userId_provider_externalId: {
            userId,
            provider: act.provider,
            externalId: act.externalId,
          },
        },
        create: {
          ...activityCreateData(userId, dedupeKey, act),
          dedupedFromId: existing.externalId,
          dedupedFromProvider: existing.provider,
        },
        update: {
          dedupedFromId: existing.externalId,
          dedupedFromProvider: existing.provider,
        },
      });
      return 'deduped';
    }

    await this.prisma.fitnessActivity.upsert({
      where: {
        userId_provider_externalId: {
          userId,
          provider: act.provider,
          externalId: act.externalId,
        },
      },
      create: activityCreateData(userId, dedupeKey, act),
      update: {
        dedupeKey,
        ...activityPatch(act),
        // No other canonical row for this fingerprint — unhide a previously self-hidden copy.
        dedupedFromId: null,
        dedupedFromProvider: null,
      },
    });
    return 'inserted';
  }

  async upsertBodyMetric(params: {
    userId: string;
    /** "weight" | "vo2max" */
    kind?: string;
    weightKg: number;
    measuredAt: Date;
    source: string;
    externalId?: string | null;
  }): Promise<void> {
    const { userId, kind = 'weight', weightKg, measuredAt, source, externalId } = params;
    await this.prisma.fitnessBodyMetric.upsert({
      where: {
        userId_source_externalId: {
          userId,
          source,
          externalId: externalId ?? 'manual',
        },
      },
      create: { userId, kind, weightKg, measuredAt, source, externalId: externalId ?? undefined },
      update: { kind, weightKg, measuredAt },
    });
  }

  async rebuildDailySummaries(
    userId: string,
    dates: Date[],
    opts: { resetSteps?: boolean } = {},
  ): Promise<void> {
    const dayKeys = [...new Set(
      dates.map((d) => {
        // Convert to user local time... for now use UTC date key.
        // TODO: accept user timezone, convert to local YYYY-MM-DD.
        return d.toISOString().slice(0, 10);
      }),
    )];

    for (const dayKey of dayKeys) {
      const startOfDay = new Date(`${dayKey}T00:00:00.000Z`);
      const endOfDay = new Date(`${dayKey}T23:59:59.999Z`);

      const activities = await this.prisma.fitnessActivity.findMany({
        where: {
          userId,
          startedAt: { gte: startOfDay, lte: endOfDay },
          dedupedFromId: null,
        },
        select: {
          durationSec: true,
          distanceM: true,
          effortScore: true,
          stepsCount: true,
        },
      });

      const fromActivities = activities.reduce((sum, a) => sum + (a.stepsCount ?? 0), 0);
      let stepsCount: number | null = fromActivities || null;
      if (!opts.resetSteps) {
        const existing = await this.prisma.fitnessDailySummary.findUnique({
          where: { userId_dayKey: { userId, dayKey } },
          select: { stepsCount: true },
        });
        stepsCount = Math.max(fromActivities, existing?.stepsCount ?? 0) || null;
      }
      const workoutMinutes = Math.round(activities.reduce((sum, a) => sum + a.durationSec, 0) / 60) || null;
      const distanceM = activities.reduce((sum, a) => sum + (a.distanceM ?? 0), 0) || null;
      const effortScore = activities.reduce((sum, a) => sum + (a.effortScore ?? 0), 0) || null;

      await this.prisma.fitnessDailySummary.upsert({
        where: { userId_dayKey: { userId, dayKey } },
        create: { userId, dayKey, stepsCount, workoutMinutes, distanceM, effortScore },
        update: { stepsCount, workoutMinutes, distanceM, effortScore },
      });
    }
  }

  async applyDailySteps(
    userId: string,
    days: Array<{ dayKey: string; stepsCount: number }>,
  ): Promise<void> {
    for (const day of days) {
      await this.prisma.fitnessDailySummary.upsert({
        where: { userId_dayKey: { userId, dayKey: day.dayKey } },
        create: { userId, dayKey: day.dayKey, stepsCount: day.stepsCount },
        update: { stepsCount: day.stepsCount },
      });
    }
  }
}
