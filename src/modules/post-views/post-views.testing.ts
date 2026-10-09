import type { PostsReadService } from "../posts-read/posts-read.service";
import type { PostsWriteService } from "../posts-read/posts-write.service";
import type { NotificationReadSubjectsService } from "../notifications";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { CacheInvalidationService } from "../redis/cache-invalidation.service";
import type { CacheService } from "../redis/cache.service";
import type { RedisService } from "../redis/redis.service";
import type { PosthogService } from "../../common/posthog/posthog.service";
import { PostViewsBatchService } from "./post-views-batch.service";
import { PostViewsService } from "./post-views.service";

/** Wires the single-view service and its batch collaborator by hand for unit tests (the module does this through DI). */
export function makePostViewsServices(
  prisma: PrismaService,
  cache: CacheService,
  redis: RedisService,
  cacheInvalidation: CacheInvalidationService,
  presenceRealtime: PresenceRealtimeService,
  posthog: PosthogService,
  notifications: Pick<
    NotificationReadSubjectsService,
    "markReadBySubject" | "markReadBySubjects"
  >,
  postsRead: PostsReadService,
  postsWrite: PostsWriteService,
): { views: PostViewsService; batch: PostViewsBatchService } {
  const views = new PostViewsService(
    prisma,
    cache,
    redis,
    cacheInvalidation,
    presenceRealtime,
    posthog,
    notifications,
    postsRead,
    postsWrite,
  );
  return {
    views,
    batch: new PostViewsBatchService(
      views,
      cache,
      cacheInvalidation,
      notifications,
      posthog,
      postsRead,
      prisma,
      redis,
    ),
  };
}
