import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Canonical authored-post total: every published, non-deleted post regardless
 * of audience tier, parent/thread position, repost kind, or group.
 *
 * `onlyMe` posts are excluded. They are reachable only through the dedicated
 * /posts/only-me feed and are filtered out of every profile feed — including
 * the author's own view of it — so counting them would print a total that no
 * viewer can reconcile with the list underneath it. It would also tell
 * anonymous callers of the public profile API how much private material a
 * member is keeping.
 *
 * `boardOnly` rows (Board comments, and threads not shared to the feed) are
 * excluded for the same reason: no profile feed lists them.
 */
export function totalUserPostsWhere(userId: string): Prisma.PostWhereInput {
  return {
    userId,
    deletedAt: null,
    isDraft: false,
    visibility: { not: 'onlyMe' },
    boardOnly: false,
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

/**
 * Board points: boosts received across a member's live Board posts and comments
 * (Hacker News-style karma). Shown on profiles; ranked on the Board leaderboard.
 */
export async function totalUserBoardPoints(
  prisma: Pick<PrismaClient, 'post'>,
  userId: string,
): Promise<number> {
  const result = await prisma.post.aggregate({
    where: { userId, kind: 'board', deletedAt: null, isDraft: false },
    _sum: { boostCount: true },
  });
  return Math.max(0, result._sum.boostCount ?? 0);
}
