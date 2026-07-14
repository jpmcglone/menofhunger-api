import type { Prisma } from '@prisma/client';

/**
 * Canonical authored-post total: every published, non-deleted post regardless
 * of visibility, audience, parent/thread position, repost kind, or group.
 */
export function totalUserPostsWhere(userId: string): Prisma.PostWhereInput {
  return {
    userId,
    deletedAt: null,
    isDraft: false,
  };
}

/** Every published, non-deleted article regardless of visibility. */
export function totalUserArticlesWhere(authorId: string): Prisma.ArticleWhereInput {
  return {
    authorId,
    deletedAt: null,
    isDraft: false,
    publishedAt: { not: null },
  };
}

/**
 * Canonical direct-comment total. Which rows a viewer may read remains
 * visibility-filtered, but the aggregate count is audience-independent.
 */
export function totalPostCommentsWhere(parentId: string): Prisma.PostWhereInput {
  return {
    parentId,
    deletedAt: null,
    isDraft: false,
  };
}
