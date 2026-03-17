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
  notificationsCountReconcile: 'notifications.countReconcile',
  notificationsEmailNudges: 'notifications.emailNudges',
  notificationsDailyDigest: 'notifications.dailyDigest',
  notificationsWeeklyDigest: 'notifications.weeklyDigest',
  notificationsInstantHighSignalEmail: 'notifications.instantHighSignalEmail',
  notificationsStreakReminderEmail: 'notifications.streakReminderEmail',
  notificationsProfileReminderEmail: 'notifications.profileReminderEmail',

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

  // Admin
  adminDailyDigest: 'admin.dailyDigest',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

