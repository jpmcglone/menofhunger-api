import type { ArticleDto } from './article.dto';
import type { PostDto } from './post.dto';
import type { UserListDto } from './user.dto';

export type LandingStatsDto = {
  /** All-time public, regular, non-draft, non-deleted posts. */
  publicPostCount: number;
  /** Verified, non-org, non-banned users with completed usernames. */
  verifiedMenCount: number;
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
