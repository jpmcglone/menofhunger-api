import { assertPublishableText } from '../../common/moderation/content-filter';
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { FitnessIngestService } from "./fitness-ingest.service";
import { PostsSharedWriteService } from "../posts/posts-shared-write.service";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import type {
  PostVisibility,
  FitnessShareType,
  FitnessActivityType,
} from "@prisma/client";
import type {
  FitnessGoalDto,
  FitnessSharePreviewDto,
  FitnessShareSnapshotDto,
} from "../../common/dto/fitness.dto";
import { toPostDto } from "../posts/post.dto";
import { vo2maxShareSnapshot } from "./fitness-share-snapshot";

@Injectable()
export class FitnessHealthDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: FitnessIngestService,
    private readonly postsSharedWrite: PostsSharedWriteService,
  ) {}

  async uploadHealthKit(
    userId: string,
    payload: {
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
      }>;
      bodyMetrics?: Array<{
        externalId: string;
        weightKg: number;
        measuredAt: string;
      }>;
      vo2maxReadings?: Array<{
        externalId: string;
        vo2maxMlKgMin: number;
        measuredAt: string;
      }>;
      sleepMinutes?: Array<{ dayKey: string; sleepMinutes: number }>;
      hrv?: Array<{ dayKey: string; hrvMs: number }>;
      dailySteps?: Array<{ dayKey: string; stepsCount: number }>;
    },
  ): Promise<{
    activitiesInserted: number;
    activitiesDeduped: number;
    metricsUpserted: number;
  }> {
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
        where: { userId_provider: { userId, provider: "apple_health" } },
        create: {
          userId,
          provider: "apple_health",
          status: "active",
          lastSyncAt: new Date(),
        },
        update: { lastSyncAt: new Date(), status: "active" },
      });
    }

    const activities = (payload.activities ?? []).map((a) => ({
      provider: "apple_health" as const,
      externalId: a.externalId,
      activityType: a.activityType,
      startedAt: new Date(a.startedAt),
      endedAt: a.endedAt ? new Date(a.endedAt) : null,
      durationSec: a.durationSec,
      distanceM: a.distanceM ?? null,
      effortScore: null,
      stepsCount: a.stepsCount ?? null,
      calories: a.calories && a.calories > 0 ? a.calories : null,
      avgHeartrate:
        a.avgHeartrate && a.avgHeartrate > 0 ? a.avgHeartrate : null,
      maxHeartrate:
        a.maxHeartrate && a.maxHeartrate > 0 ? a.maxHeartrate : null,
      totalElevationM:
        a.totalElevationM && a.totalElevationM > 0 ? a.totalElevationM : null,
      name: a.name?.trim() ? a.name.trim() : null,
      // Never persist client `raw` (GPS/HR series). That payload 500'd the upload.
      rawJson: {
        source: "apple_health",
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

    const { inserted, deduped } =
      activities.length > 0
        ? await this.ingest.upsertActivities(userId, activities)
        : { inserted: 0, deduped: 0 };

    for (const bm of payload.bodyMetrics ?? []) {
      await this.ingest.upsertBodyMetric({
        userId,
        kind: "weight",
        weightKg: bm.weightKg,
        measuredAt: new Date(bm.measuredAt),
        source: "apple_health",
        externalId: bm.externalId,
      });
      metricsUpserted++;
    }

    for (const v of payload.vo2maxReadings ?? []) {
      await this.ingest.upsertBodyMetric({
        userId,
        kind: "vo2max",
        weightKg: v.vo2maxMlKgMin,
        measuredAt: new Date(v.measuredAt),
        source: "apple_health",
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

    return {
      activitiesInserted: inserted,
      activitiesDeduped: deduped,
      metricsUpserted,
    };
  }

  async upsertWeightGoal(
    userId: string,
    params: { startKg?: number; targetKg: number },
  ): Promise<FitnessGoalDto> {
    const existing = await this.prisma.fitnessGoal.findFirst({
      where: { userId, kind: "weight", completedAt: null },
      orderBy: { createdAt: "desc" },
    });

    let goal;
    if (existing) {
      goal = await this.prisma.fitnessGoal.update({
        where: { id: existing.id },
        data: {
          startKg: params.startKg ?? existing.startKg,
          targetKg: params.targetKg,
        },
      });
    } else {
      goal = await this.prisma.fitnessGoal.create({
        data: {
          userId,
          kind: "weight",
          startKg: params.startKg ?? null,
          targetKg: params.targetKg,
        },
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

  async createSharePost(params: {
    userId: string;
    shareType: FitnessShareType;
    body: string;
    visibility: PostVisibility;
    activityId?: string;
    bodyMetricId?: string;
    goalId?: string;
    r2BaseUrl?: string | null;
  }): Promise<{
    post: ReturnType<typeof toPostDto>;
    fitnessShare: FitnessSharePreviewDto;
  }> {
    const {
      userId,
      shareType,
      body,
      visibility,
      activityId,
      bodyMetricId,
      goalId,
      r2BaseUrl,
    } = params;

    // Validate before persisting the source snapshot; the post command also defends its boundary.
    assertPublishableText(body);

    const snapshot = await this.buildSnapshot({
      userId,
      shareType,
      activityId,
      bodyMetricId,
      goalId,
    });

    const share = await this.prisma.fitnessShare.create({
      data: {
        userId,
        shareType,
        activityId: activityId ?? null,
        bodyMetricId: bodyMetricId ?? null,
        goalId: goalId ?? null,
        snapshot,
      },
    });

    const post = await this.postsSharedWrite.createFitnessShare({
      userId,
      body,
      visibility: visibility,
      fitnessShareId: share.id,
    });

    const postDto = toPostDto(post, r2BaseUrl ?? null);
    const previewDto: FitnessSharePreviewDto = {
      id: share.id,
      shareType,
      snapshot,
    };

    return { post: postDto, fitnessShare: previewDto };
  }

  async buildSnapshot(params: {
    userId: string;
    shareType: FitnessShareType;
    activityId?: string;
    bodyMetricId?: string;
    goalId?: string;
  }): Promise<FitnessShareSnapshotDto> {
    const { userId, shareType, activityId, bodyMetricId, goalId } = params;

    if (shareType === "activity") {
      if (!activityId)
        throw new BadRequestException(
          "activityId is required for activity share.",
        );
      const activity = await this.prisma.fitnessActivity.findFirst({
        where: { id: activityId, userId },
      });
      if (!activity) throw new NotFoundException("Activity not found.");
      return {
        type: "activity",
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

    if (shareType === "weight") {
      const metricId = bodyMetricId ?? null;
      let metric;
      if (metricId) {
        metric = await this.prisma.fitnessBodyMetric.findFirst({
          where: { id: metricId, userId, kind: "weight" },
        });
      } else {
        metric = await this.prisma.fitnessBodyMetric.findFirst({
          where: { userId, kind: "weight" },
          orderBy: { measuredAt: "desc" },
        });
      }
      if (!metric) throw new NotFoundException("No weight data found.");

      const previous = await this.prisma.fitnessBodyMetric.findFirst({
        where: {
          userId,
          kind: "weight",
          measuredAt: { lt: metric.measuredAt },
        },
        orderBy: { measuredAt: "desc" },
      });

      const deltaKg = previous ? metric.weightKg - previous.weightKg : null;

      return {
        type: "weight",
        data: {
          weightKg: metric.weightKg,
          measuredAt: metric.measuredAt.toISOString(),
          previousWeightKg: previous?.weightKg ?? null,
          deltaKg,
        },
      };
    }

    if (shareType === "progress") {
      const goal = goalId
        ? await this.prisma.fitnessGoal.findFirst({
            where: { id: goalId, userId },
          })
        : await this.prisma.fitnessGoal.findFirst({
            where: { userId, kind: "weight", completedAt: null },
            orderBy: { createdAt: "desc" },
          });
      if (!goal) throw new NotFoundException("No active weight goal found.");

      const currentMetric = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, kind: "weight" },
        orderBy: { measuredAt: "desc" },
      });

      return {
        type: "progress",
        data: {
          startKg: goal.startKg,
          currentKg: currentMetric?.weightKg ?? null,
          targetKg: goal.targetKg,
          startedAt: goal.startedAt.toISOString(),
        },
      };
    }

    if (shareType === "vo2max") {
      const metricId = bodyMetricId ?? null;
      const latest = metricId
        ? await this.prisma.fitnessBodyMetric.findFirst({
            where: { id: metricId, userId, kind: "vo2max" },
          })
        : await this.prisma.fitnessBodyMetric.findFirst({
            where: { userId, kind: "vo2max" },
            orderBy: { measuredAt: "desc" },
          });
      if (!latest) throw new NotFoundException("No VO2 max data found.");

      const first = await this.prisma.fitnessBodyMetric.findFirst({
        where: { userId, kind: "vo2max" },
        orderBy: { measuredAt: "asc" },
      });

      return vo2maxShareSnapshot({ latest, first });
    }

    throw new BadRequestException(`Unknown shareType: ${shareType}`);
  }
}
