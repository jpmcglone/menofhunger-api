export const MOH_BACKGROUND_QUEUE = 'moh_background';

export const JOBS = {
  // Posts
  postsPollResultsReadySweep: 'posts.pollResultsReadySweep',
  postsTopicsBackfill: 'posts.topicsBackfill',
  postsPopularScoreRefresh: 'posts.popularScoreRefresh',
  postsRefreshSinglePostScore: 'posts.refreshSinglePostScore',

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

