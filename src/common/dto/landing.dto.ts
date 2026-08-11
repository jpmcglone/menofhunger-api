import type { ArticleDto } from './article.dto';
import type { PostDto } from './post.dto';
import type { UserListDto } from './user.dto';

export type LandingMenBreakdownDto = {
  /** premium OR premiumPlus. */
  premium: number;
  /** verifiedStatus != 'none' AND NOT (premium OR premiumPlus). */
  verified: number;
  /** premium + verified. */
  total: number;
  /**
   * Distinct verified men who authored ≥1 landing-eligible post or reply
   * (same post filters as `LandingPostBreakdownDto.total`).
   */
  contributors: number;
};

export type LandingPostBreakdownDto = {
  /** visibility = 'public'. */
  public: number;
  /** visibility = 'verifiedOnly'. */
  verified: number;
  /** visibility = 'premiumOnly'. */
  premium: number;
  /** Top-level posts (parentId IS NULL). */
  original: number;
  /** Replies/comments (parentId IS NOT NULL). */
  replies: number;
  /** public + verified + premium (onlyMe excluded). Equals original + replies. */
  total: number;
};

/**
 * Site-wide unique views (person×post), matching per-post `viewerCount` semantics.
 * Guests are derived as total − authenticated tier counts.
 */
export type LandingViewsBreakdownDto = {
  premium: number;
  verified: number;
  unverified: number;
  guest: number;
  /** Sum of Post.viewerCount on landing-eligible posts. */
  total: number;
};

export type LandingStatsDto = {
  men: LandingMenBreakdownDto;
  posts: LandingPostBreakdownDto;
  views: LandingViewsBreakdownDto;
};

export type LandingTopPostDto = PostDto & {
  /** Distinct logged-in/anonymous viewers active on this post in the last 7 days. */
  weeklyViewCount: number;
};

export type LandingSnapshotDto = {
  stats: LandingStatsDto;
  recentlyActiveMen: UserListDto[];
  topPostsThisWeek: LandingTopPostDto[];
  trendingArticles: ArticleDto[];
  asOf: string;
};
