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
  /** Sum of all user coin balances — total coins in the economy */
  totalCoinsInEconomy: number;
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

export type AdminAnalyticsCoinsDto = {
  /** Sum of all user coin balances (all time, all non-banned users). */
  totalInEconomy: number;
  /** Coins minted from streak rewards in the selected range. */
  mintedInRange: number;
  /** Coins sent peer-to-peer in the selected range. */
  transferredInRange: number;
  /** Distinct users who earned streak coins in the selected range. */
  uniqueEarnersInRange: number;
  /** Distinct users who sent coins to others in the selected range. */
  uniqueSendersInRange: number;
  /** Coins minted per time bucket in the selected range. */
  minted: TimeSeriesPoint[];
  /** Coins minted grouped by multiplier amount (1, 2, 3, 4). */
  mintedByMultiplier: Record<string, number>;
  /**
   * Velocity ratio: transferred / minted in the selected range.
   * > 1 means more coins are moving than being created (unusual; could indicate re-circling).
   * Null when minted = 0.
   */
  velocityRatio: number | null;
  /**
   * Gini coefficient of the all-time coin distribution (0 = perfect equality, 1 = extreme inequality).
   * Computed over all non-banned users with coins > 0.
   * Null when there are no holders.
   */
  giniCoefficient: number | null;
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
  coins: AdminAnalyticsCoinsDto;
  articles: AdminAnalyticsArticlesDto;
  asOf: string;
};
