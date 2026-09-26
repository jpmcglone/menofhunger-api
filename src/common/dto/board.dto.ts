import type { PostAuthorDto, PostDto, PostMediaDto, PostMentionDto } from './post.dto';
import { gatedBoardTitle } from './post.dto';
import type { UserListDto } from './user.dto';

export type BoardVisibility = 'public' | 'verifiedOnly' | 'premiumOnly';

/**
 * A Board thread. The thread is a Post (kind=board); `id` is that post id, so boosts,
 * bookmarks, views, and reports use the regular post endpoints.
 *
 * When `viewerCanAccess` is false the thread is a teaser: trimmed title, tags, scope,
 * counts, and age only (no link, text, image, or author).
 */
export type BoardThreadDto = {
  id: string;
  title: string;
  url: string | null;
  domain: string | null;
  tags: string[];
  visibility: BoardVisibility;
  body: string | null;
  image: PostMediaDto | null;
  author: PostAuthorDto | null;
  mentions: PostMentionDto[];
  createdAt: string;
  editedAt: string | null;
  points: number;
  commentCount: number;
  /** Unique people who saw the thread (same counter as posts). */
  viewerCount: number;
  /** Impressions: every counted view, including repeat looks (same counter as posts). */
  totalViewCount: number;
  /** The signed-in viewer has seen this thread before. */
  viewerHasViewed?: boolean;
  /**
   * When the signed-in viewer last opened this thread, before the current visit is recorded.
   * Clients mark comments created after it (by others) as new. Null on a first visit.
   */
  viewerLastSeenAt?: string | null;
  /** Article Board posts only: estimated reading time of the article. */
  readingTimeMinutes?: number;
  showInFeed: boolean;
  /** Set when the thread was created from an article publish; comments live on the article. */
  articleId: string | null;
  viewerCanAccess: boolean;
  viewerHasBoosted: boolean;
  viewerHasBookmarked: boolean;
  viewerHidden: boolean;
  viewerCanEdit: boolean;
};

/** Minimal thread reference carried by comments listed outside their thread. */
export type BoardThreadRefDto = {
  id: string;
  title: string;
  visibility: BoardVisibility;
};

export type BoardCommentDto = {
  id: string;
  threadId: string;
  /** Null for top-level comments (direct replies to the thread). */
  parentId: string | null;
  depth: number;
  body: string;
  author: PostAuthorDto;
  mentions: PostMentionDto[];
  createdAt: string;
  deleted: boolean;
  points: number;
  replyCount: number;
  viewerHasBoosted: boolean;
  replies: BoardCommentDto[];
  /** Present on comments listed outside their thread (Comments tab, profiles). */
  thread?: BoardThreadRefDto;
};

export type BoardCommentsPageDto = {
  viewerCanAccess: boolean;
  comments: BoardCommentDto[];
};

export type BoardCommentContextDto = {
  thread: BoardThreadDto;
  /** Root-first chain of parent comments (without their replies). */
  ancestors: BoardCommentDto[];
  /** The requested comment with its reply subtree. Null when the viewer cannot read the thread. */
  comment: BoardCommentDto | null;
};

export type BoardTagDto = {
  slug: string;
  label: string;
  threadCount: number;
};

/** Member ranked by Board points: boosts received across live Board posts and comments. */
export type BoardLeaderboardUserDto = UserListDto & { boardPoints: number };

export type BoardLeaderboardDto = {
  users: BoardLeaderboardUserDto[];
  /** The viewer's own rank when they have points but sit outside `users`. */
  viewerRank: { rank: number; user: BoardLeaderboardUserDto } | null;
  generatedAt: string;
};

export type BoardPreferencesDto = {
  shareToFeedDefault: boolean;
  articlePostToBoardDefault: boolean;
};

export type BoardThreadRowFields = {
  title: string;
  url: string | null;
  domain: string | null;
  tags: string[];
  showInFeed: boolean;
};

export function toBoardThreadDto(
  post: PostDto,
  thread: BoardThreadRowFields,
  opts: {
    viewerCanAccess: boolean;
    viewerHidden: boolean;
    viewerCanEdit: boolean;
    articleId: string | null;
  },
): BoardThreadDto {
  const visibility = (post.visibility === 'onlyMe' ? 'public' : post.visibility) as BoardVisibility;
  const canAccess = opts.viewerCanAccess;
  return {
    id: post.id,
    title: canAccess ? thread.title : gatedBoardTitle(thread.title),
    url: canAccess ? thread.url : null,
    domain: canAccess ? thread.domain : null,
    tags: thread.tags ?? [],
    visibility,
    body: canAccess ? (post.body || null) : null,
    image: canAccess ? (post.media.find((m) => !m.deletedAt) ?? null) : null,
    author: canAccess ? post.author : null,
    mentions: canAccess ? post.mentions : [],
    createdAt: post.createdAt,
    editedAt: canAccess ? post.editedAt : null,
    points: post.boostCount,
    commentCount: post.commentCount,
    viewerCount: post.viewerCount,
    totalViewCount: Math.max(post.viewerCount, post.totalViewCount ?? post.viewerCount),
    ...(typeof post.viewerHasViewed === 'boolean' ? { viewerHasViewed: post.viewerHasViewed } : {}),
    showInFeed: thread.showInFeed,
    articleId: opts.articleId,
    viewerCanAccess: canAccess,
    viewerHasBoosted: Boolean(post.viewerHasBoosted),
    viewerHasBookmarked: Boolean(post.viewerHasBookmarked),
    viewerHidden: opts.viewerHidden,
    viewerCanEdit: canAccess && opts.viewerCanEdit,
  };
}

export function toBoardCommentDto(
  post: PostDto,
  opts: { threadId: string; depth: number; thread?: BoardThreadRefDto },
): BoardCommentDto {
  const deleted = Boolean(post.deletedAt);
  return {
    id: post.id,
    threadId: opts.threadId,
    parentId: post.parentId && post.parentId !== opts.threadId ? post.parentId : null,
    depth: opts.depth,
    body: deleted ? '' : post.body,
    author: post.author,
    mentions: deleted ? [] : post.mentions,
    createdAt: post.createdAt,
    deleted,
    points: post.boostCount,
    replyCount: post.commentCount,
    viewerHasBoosted: Boolean(post.viewerHasBoosted),
    replies: [],
    ...(opts.thread ? { thread: opts.thread } : {}),
  };
}
