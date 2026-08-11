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
  /** Distinct verified men who authored ≥1 landing-eligible original (non-reply) post. */
  originalAuthors: number;
  /**
   * Share of landing-eligible content written by the single most prolific author.
   * Integer percent 0–100, rounded; denominator is `LandingPostBreakdownDto.total`.
   */
  topAuthorSharePercent: number;
  /**
   * Share of landing-eligible content written by the five most prolific authors.
   * Integer percent 0–100, rounded; denominator is `LandingPostBreakdownDto.total`.
   */
  top5SharePercent: number;
  /**
   * Median posts+replies among contributors only (men with ≥1 eligible item).
   * Integer, rounded; 0 when there are no contributors.
   */
  medianPostsPerContributor: number;
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

/**
 * Published articles by landing-eligible authors (same author filters as posts).
 * Drafts / deleted / onlyMe excluded. Views match Article.viewCount (person×article).
 */
export type LandingArticleBreakdownDto = {
  /** visibility = 'public'. */
  public: number;
  /** visibility = 'verifiedOnly'. */
  verified: number;
  /** visibility = 'premiumOnly'. */
  premium: number;
  /** public + verified + premium. */
  total: number;
  /** Distinct authors of landing-eligible published articles. */
  authors: number;
  /** Sum of Article.viewCount on landing-eligible articles. */
  views: number;
};

export type LandingStatsDto = {
  men: LandingMenBreakdownDto;
  posts: LandingPostBreakdownDto;
  articles: LandingArticleBreakdownDto;
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
