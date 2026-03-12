export type AnalyticsRange = '7d' | '30d' | '3m' | '1y' | 'all';
export type AnalyticsGranularity = 'day' | 'week' | 'month';

export type TimeSeriesPoint = { bucket: string; count: number };

export type AdminAnalyticsSummaryDto = {
  totalUsers: number;
  verifiedUsers: number;
  premiumUsers: number;
  premiumPlusUsers: number;
  /** Users with at least one active (non-revoked, non-expired) subscription grant */
  usersWithActiveGrants: number;
  dau: number;
  mau: number;
};

export type AdminAnalyticsRetentionRow = {
  cohortWeek: string;
  size: number;
  w1: number;
  w4: number;
};

export type AdminAnalyticsEngagementDto = {
  /** Users who signed up 30–37 days ago */
  d30CohortSize: number;
  /** Of that cohort, how many were active in the last 7 days */
  d30RetainedCount: number;
  /** null when cohort is empty (no data yet) */
  d30RetentionPct: number | null;

  /** Users old enough to measure (7+ days since signup) */
  activationEligibleCount: number;
  /** Of those, how many had any activity in their first 7 days */
  activationCount: number;
  /** null when no eligible users yet */
  activationPct: number | null;

  /** Unique active users in the last 30 days (MAU) */
  creatorMauCount: number;
  /** Of MAU, how many created at least 1 post or check-in */
  creatorCount: number;
  /** null when no MAU yet */
  creatorPct: number | null;

  avgFollowersPerUser: number;
  connectedUserCount: number;
  /** null when no users yet */
  connectedUserPct: number | null;
};

export type AdminAnalyticsTopArticleDto = {
  id: string;
  title: string;
  slug: string;
  visibility: string;
  authorUsername: string;
  viewCount: number;
  boostCount: number;
  commentCount: number;
  reactionCount: number;
  publishedAt: string;
};

export type AdminAnalyticsArticleKpiDto = {
  /** All-time published article count */
  totalPublished: number;
  /** All-time draft count */
  totalDrafts: number;
  /** Unique authors who have published at least one article */
  uniqueAuthors: number;
  /** Article views recorded in the selected range */
  totalViewsInRange: number;
  /** Article boosts recorded in the selected range */
  totalBoostsInRange: number;
  /** Article reactions recorded in the selected range */
  totalReactionsInRange: number;
  /** Article comments (non-deleted) created in the selected range */
  totalCommentsInRange: number;
  /** Average views per published article for articles published in the range */
  avgViewsPerArticle: number;
};

export type AdminAnalyticsArticlesDto = {
  kpis: AdminAnalyticsArticleKpiDto;
  /** Time series — articles published per bucket in the selected range */
  published: TimeSeriesPoint[];
  /** Time series — article views recorded per bucket in the selected range */
  views: TimeSeriesPoint[];
  /** Published (non-deleted) article count by visibility tier (all time) */
  byVisibility: Record<string, number>;
  /** Top articles by view count in the selected range */
  topArticles: AdminAnalyticsTopArticleDto[];
};

export type AdminAnalyticsMonetizationDto = {
  free: number;
  payingPremium: number;
  payingPremiumPlus: number;
  compedPremium: number;
  compedPremiumPlus: number;
  byStatus: Record<string, number>;
};

export type AdminAnalyticsDto = {
  range: AnalyticsRange;
  granularity: AnalyticsGranularity;
  summary: AdminAnalyticsSummaryDto;
  signups: TimeSeriesPoint[];
  /** Counts of regular (non-draft, non-deleted) posts per visibility for the selected range. */
  postsByVisibility: Record<string, number>;
  /** Time series of regular posts visible to others (excludes onlyMe). */
  posts: TimeSeriesPoint[];
  checkins: TimeSeriesPoint[];
  messages: TimeSeriesPoint[];
  follows: TimeSeriesPoint[];
  retention: AdminAnalyticsRetentionRow[];
  engagement: AdminAnalyticsEngagementDto;
  monetization: AdminAnalyticsMonetizationDto;
  articles: AdminAnalyticsArticlesDto;
  asOf: string;
};
