import { Injectable, Logger } from '@nestjs/common';
import type { FitnessProvider, FitnessActivityType } from '@prisma/client';
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
};

function buildDedupeKey(a: NormalizedActivity): string {
  const startBucket = Math.floor(a.startedAt.getTime() / (DEDUP_TIME_TOLERANCE_SEC * 1000));
  const durationBucket = Math.floor(a.durationSec / DEDUP_DURATION_TOLERANCE_SEC);
  const distanceBucket = a.distanceM ? Math.floor(a.distanceM / DEDUP_DISTANCE_TOLERANCE_M) : 'x';
  return `${a.activityType}:${startBucket}:${durationBucket}:${distanceBucket}`;
}

/**
 * Which provider wins when two sources provide the same activity.
 * Strava > Apple Health: Strava has GPS + Suffer Score; HealthKit may be a double-count from the watch.
 */
const PROVIDER_PRIORITY: Record<FitnessProvider, number> = {
  strava: 10,
  apple_health: 5,
};

@Injectable()
export class FitnessIngestService {
  private readonly logger = new Logger(FitnessIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertActivities(userId: string, activities: NormalizedActivity[]): Promise<{ inserted: number; deduped: number }> {
    let inserted = 0;
    let deduped = 0;

    for (const act of activities) {
      const dedupeKey = buildDedupeKey(act);

      const existing = await this.prisma.fitnessActivity.findFirst({
        where: { userId, dedupeKey, dedupedFromId: null },
        select: { id: true, provider: true, externalId: true },
      });

      if (existing) {
        const existingPriority = PROVIDER_PRIORITY[existing.provider] ?? 0;
        const incomingPriority = PROVIDER_PRIORITY[act.provider] ?? 0;

        if (incomingPriority > existingPriority) {
          // Incoming wins: mark the existing as deduped, upsert incoming as canonical.
          await this.prisma.fitnessActivity.update({
            where: { id: existing.id },
            data: {
              dedupedFromId: act.externalId,
              dedupedFromProvider: act.provider,
            },
          });
          await this.prisma.fitnessActivity.upsert({
            where: { userId_provider_externalId: { userId, provider: act.provider, externalId: act.externalId } },
            create: { userId, dedupeKey, ...act, startedAt: act.startedAt },
            update: {
              durationSec: act.durationSec,
              distanceM: act.distanceM,
              effortScore: act.effortScore,
              stepsCount: act.stepsCount,
              calories: act.calories,
              avgHeartrate: act.avgHeartrate,
              maxHeartrate: act.maxHeartrate,
            },
          });
          inserted++;
        } else {
          // Existing wins: mark incoming as deduped.
          await this.prisma.fitnessActivity.upsert({
            where: { userId_provider_externalId: { userId, provider: act.provider, externalId: act.externalId } },
            create: {
              userId,
              dedupeKey,
              ...act,
              startedAt: act.startedAt,
              dedupedFromId: existing.externalId,
              dedupedFromProvider: existing.provider,
            },
            update: {
              dedupedFromId: existing.externalId,
              dedupedFromProvider: existing.provider,
            },
          });
          deduped++;
        }
      } else {
        await this.prisma.fitnessActivity.upsert({
          where: { userId_provider_externalId: { userId, provider: act.provider, externalId: act.externalId } },
          create: { userId, dedupeKey, ...act, startedAt: act.startedAt },
          update: {
            durationSec: act.durationSec,
            distanceM: act.distanceM,
            effortScore: act.effortScore,
            stepsCount: act.stepsCount,
            calories: act.calories,
            avgHeartrate: act.avgHeartrate,
            maxHeartrate: act.maxHeartrate,
          },
        });
        inserted++;
      }
    }

    if (activities.length > 0) {
      await this.rebuildDailySummaries(userId, activities.map((a) => a.startedAt));
    }

    return { inserted, deduped };
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

  async rebuildDailySummaries(userId: string, dates: Date[]): Promise<void> {
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

      const stepsCount = activities.reduce((sum, a) => sum + (a.stepsCount ?? 0), 0) || null;
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
}
