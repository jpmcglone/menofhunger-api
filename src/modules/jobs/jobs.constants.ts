export const MOH_BACKGROUND_QUEUE = 'moh_background';

export const JOBS = {
  // Posts
  postsPollResultsReadySweep: 'posts.pollResultsReadySweep',
  postsTopicsBackfill: 'posts.topicsBackfill',
  postsPopularScoreRefresh: 'posts.popularScoreRefresh',

  // Hashtags
  hashtagsTrendingScoreRefresh: 'hashtags.trendingScoreRefresh',
  hashtagsCleanup: 'hashtags.cleanup',

  // Notifications + email
  notificationsCleanup: 'notifications.cleanup',
  notificationsOrphanCleanup: 'notifications.orphanCleanup',
  notificationsEmailNudges: 'notifications.emailNudges',
  notificationsWeeklyDigest: 'notifications.weeklyDigest',

  // Auth / search
  authCleanup: 'auth.cleanup',
  searchCleanup: 'search.cleanup',

  // Link metadata
  linkMetadataBackfill: 'linkMetadata.backfill',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

