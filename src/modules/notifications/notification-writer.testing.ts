import type { CacheInvalidationService } from "../redis/cache-invalidation.service";
import type { MutesService } from "../mutes/mutes.service";
import type { PostsReadService } from "../posts-read/posts-read.service";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PresenceRedisReadService } from "../presence/presence-redis-read.service";
import type { JobsService } from "../jobs/jobs.service";
import type { SideEffectsService } from "../side-effects/side-effects.service";
import type { PrismaService } from "../prisma/prisma.service";
import { NotificationCreatorService } from "./notification-creator.service";
import { NotificationEngagementWriterService } from "./notification-engagement-writer.service";
import { NotificationFanoutContentService } from "./notification-fanout-content.service";
import { NotificationInviteWriterService } from "./notification-invite-writer.service";
import type { NotificationQueryService } from "./notification-query.service";
import type { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationWriterCommunityService } from "./notification-writer-community.service";
import { NotificationWriterFanoutService } from "./notification-writer-fanout.service";
import { NotificationCleanupService } from "./notification-cleanup.service";
import { NotificationFollowPolicyService } from "./notification-follow-policy.service";
import { NotificationMarvWriterService } from "./notification-marv-writer.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";

/** Wires the notification writer object graph by hand for unit tests (the module does this through DI). */
export function makeNotificationWriterGraph(
  prisma: PrismaService,
  postsRead: PostsReadService,
  presenceRealtime: PresenceRealtimeService,
  presenceRedis: PresenceRedisReadService,
  jobs: JobsService,
  sideEffects: SideEffectsService,
  query: NotificationQueryService,
  readState: NotificationReadStateService,
  cacheInvalidation?: CacheInvalidationService,
  mutes?: MutesService,
) {
  const support = new NotificationWriterSupportService(
    prisma,
    postsRead,
    presenceRealtime,
    presenceRedis,
    sideEffects,
    readState,
    cacheInvalidation,
    mutes,
  );
  const invites = new NotificationInviteWriterService(
    prisma,
    presenceRealtime,
    sideEffects,
    query,
    readState,
    support,
    cacheInvalidation,
  );
  const community = new NotificationWriterCommunityService(
    prisma,
    postsRead,
    presenceRealtime,
    jobs,
    sideEffects,
    query,
    readState,
    support,
    cacheInvalidation,
    mutes,
  );
  const fanoutContent = new NotificationFanoutContentService(
    prisma,
    presenceRealtime,
    sideEffects,
    readState,
    support,
  );
  const creator = new NotificationCreatorService(
    prisma,
    postsRead,
    presenceRealtime,
    jobs,
    sideEffects,
    query,
    readState,
    support,
  );
  const fanout = new NotificationWriterFanoutService(
    prisma,
    postsRead,
    presenceRealtime,
    jobs,
    sideEffects,
    query,
    readState,
    support,
    creator,
    cacheInvalidation,
    mutes,
  );
  const engagement = new NotificationEngagementWriterService(
    prisma,
    presenceRealtime,
    sideEffects,
    query,
    readState,
    support,
  );
  const cleanup = new NotificationCleanupService(
    prisma,
    presenceRealtime,
    sideEffects,
    readState,
    support,
    cacheInvalidation ?? { bumpNotificationsList: async () => 0 },
  );
  const followPolicy = new NotificationFollowPolicyService(prisma);
  const marv = new NotificationMarvWriterService(prisma, creator);
  const writer = {
    create: creator.create.bind(creator),
    hasRecentFollowNotification:
      followPolicy.hasRecentFollowNotification.bind(followPolicy),
    upsertMarvNotInGroupNotification:
      marv.upsertMarvNotInGroupNotification.bind(marv),
    findExistingBoostNotification:
      engagement.findExistingBoostNotification.bind(engagement),
    upsertBoostNotification:
      engagement.upsertBoostNotification.bind(engagement),
    deleteBoostNotification:
      engagement.deleteBoostNotification.bind(engagement),
    deleteArticleBoostNotification:
      engagement.deleteArticleBoostNotification.bind(engagement),
    upsertRepostNotification:
      engagement.upsertRepostNotification.bind(engagement),
    deleteRepostNotification:
      engagement.deleteRepostNotification.bind(engagement),
    deleteBySubjectPostId: cleanup.deleteBySubjectPostId.bind(cleanup),
    deleteByActorPostId: cleanup.deleteByActorPostId.bind(cleanup),
    deleteCrewJoinedNotificationsForActor:
      cleanup.deleteCrewJoinedNotificationsForActor.bind(cleanup),
    deleteFollowNotification: cleanup.deleteFollowNotification.bind(cleanup),
  };
  return { writer, community, fanout, invites, fanoutContent };
}

/** The writer alone, for specs that only exercise row writes and engagement upserts. */
export function makeNotificationWriter(
  ...args: Parameters<typeof makeNotificationWriterGraph>
) {
  return makeNotificationWriterGraph(...args).writer;
}
