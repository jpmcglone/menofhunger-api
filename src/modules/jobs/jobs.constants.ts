export const MOH_BACKGROUND_QUEUE = 'moh_background';

/**
 * Dedicated queue for Marv (AI helper) jobs. Marv runs on its own queue so its worker
 * concurrency can be tuned independently of the cron-heavy `moh_background` queue —
 * a slow notifications-email or hashtags-cleanup sweep should never delay a user's
 * @marv reply. Concurrency is set on the @Processor decorator (see MarvinProcessor)
 * and tuned via `MARV_QUEUE_CONCURRENCY` (default 8).
 */
export const MOH_MARVIN_QUEUE = 'moh_marvin';

export const JOBS = {
  // Posts
  postsPollResultsReadySweep: 'posts.pollResultsReadySweep',
  postsTopicsBackfill: 'posts.topicsBackfill',
  postsPopularScoreRefresh: 'posts.popularScoreRefresh',
  postsRefreshSinglePostScore: 'posts.refreshSinglePostScore',
  postsScheduledPublishSweep: 'posts.scheduledPublishSweep',

  // Hashtags
  hashtagsTrendingScoreRefresh: 'hashtags.trendingScoreRefresh',
  hashtagsCleanup: 'hashtags.cleanup',

  // Notifications + email
  notificationsCleanup: 'notifications.cleanup',
  notificationsOrphanCleanup: 'notifications.orphanCleanup',
  notificationsEmailNudges: 'notifications.emailNudges',
  notificationsDailyDigest: 'notifications.dailyDigest',
  notificationsWeeklyDigest: 'notifications.weeklyDigest',
  notificationsInstantHighSignalEmail: 'notifications.instantHighSignalEmail',
  notificationsStreakReminderEmail: 'notifications.streakReminderEmail',
  notificationsProfileReminderEmail: 'notifications.profileReminderEmail',
  notificationsReplyNudgePush: 'notifications.replyNudgePush',

  // Daily content (quote/definition snapshots)
  dailyContentRefresh: 'dailyContent.refresh',

  // Auth / search
  authCleanup: 'auth.cleanup',
  searchCleanup: 'search.cleanup',

  // Link metadata
  linkMetadataBackfill: 'linkMetadata.backfill',

  // Check-ins
  checkinsStreakReset: 'checkins.streakReset',
  checkinsStreakReminderPush: 'checkins.streakReminderPush',

  // Articles
  articlesViewMilestoneSweep: 'articles.viewMilestoneSweep',
  articlesFollowedArticleEmail: 'articles.followedArticleEmail',

  // Admin
  adminDailyDigest: 'admin.dailyDigest',

  // Crew
  crewInvitesExpire: 'crew.invitesExpire',
  crewTransferVotesExpire: 'crew.transferVotesExpire',
  crewInactiveOwnerAutoTransfer: 'crew.inactiveOwnerAutoTransfer',

  // Marvin (the AI helper)
  marvinReplyPublic: 'marvin.reply.public',
  marvinReplyPrivate: 'marvin.reply.private',
  marvinContextCardsRefresh: 'marvin.contextCards.refresh',
  marvinSummarizeThread: 'marvin.summarizeThread',
  marvinCostRollup: 'marvin.costRollup',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/**
 * Job names that run on the dedicated Marv queue (`MOH_MARVIN_QUEUE`). Everything else
 * goes to the shared background queue. JobsService picks the queue by membership of
 * this set, so producers don't need to know about queue routing.
 */
export const MARVIN_JOB_NAMES: ReadonlySet<JobName> = new Set<JobName>([
  JOBS.marvinReplyPublic,
  JOBS.marvinReplyPrivate,
  JOBS.marvinContextCardsRefresh,
  JOBS.marvinSummarizeThread,
  JOBS.marvinCostRollup,
]);

/** Returns the BullMQ queue name a given job should be enqueued onto. */
export function queueForJob(name: JobName): typeof MOH_BACKGROUND_QUEUE | typeof MOH_MARVIN_QUEUE {
  return MARVIN_JOB_NAMES.has(name) ? MOH_MARVIN_QUEUE : MOH_BACKGROUND_QUEUE;
}

