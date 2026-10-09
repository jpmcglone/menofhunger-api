import type { EmbeddingsService } from "../embeddings/embeddings.service";
import type { NotificationCreatorService } from "../notifications";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "../redis/redis.service";
import type { SideEffectsService } from "../side-effects/side-effects.service";
import type { ViewerContextService } from "../viewer/viewer-context.service";
import type { AppConfigService } from "../app/app-config.service";
import type { PosthogService } from "../../common/posthog/posthog.service";
import { FollowListsService } from "./follows-lists.service";
import { FollowMeaningRecommendationsService } from "./follows-meaning.service";
import { FollowNudgeService } from "./follows-nudge.service";
import { FollowRecommendationsService } from "./follows-recommendations.service";
import { FollowRelationshipsService } from "./follows-relationships.service";
import { FollowsService } from "./follows.service";

/** Wires FollowsService and its collaborators by hand for unit tests (the module does this through DI). */
export function makeFollowsService(
  prisma: PrismaService,
  appConfig: AppConfigService,
  notifications: Pick<NotificationCreatorService, "create">,
  sideEffects: SideEffectsService,
  redis: RedisService,
  presenceRealtime: PresenceRealtimeService,
  viewerContext: ViewerContextService,
  posthog: PosthogService,
  embeddings?: EmbeddingsService,
): FollowsService {
  const relationships = new FollowRelationshipsService(
    prisma,
    appConfig,
    viewerContext,
  );
  return new FollowsService(
    prisma,
    appConfig,
    viewerContext,
    sideEffects,
    presenceRealtime,
    posthog,
    relationships,
    new FollowRecommendationsService(relationships, prisma, redis),
    new FollowMeaningRecommendationsService(
      relationships,
      appConfig,
      prisma,
      embeddings,
    ),
    new FollowNudgeService(relationships, notifications, prisma, viewerContext),
    new FollowListsService(relationships, appConfig, prisma, viewerContext),
  );
}
