import { Prisma } from "@prisma/client";

/** Social proof counts a followed person once across boosts, replies, and reposts.
 * Aggregation returns at most one row per candidate, regardless of conversation size.
 */
export function friendEngagementSql(
  postIds: string[],
  followingIds: string[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT e."postId", COUNT(DISTINCT e."userId")::integer AS "people", MAX(e."createdAt") AS "latestAt"
    FROM (
      SELECT b."postId", b."userId", b."createdAt" FROM "Boost" b
      WHERE b."postId" IN (${Prisma.join(postIds)}) AND b."userId" IN (${Prisma.join(followingIds)})
      UNION ALL
      SELECT p."parentId" AS "postId", p."userId", p."createdAt" FROM "Post" p
      WHERE p."parentId" IN (${Prisma.join(postIds)}) AND p."userId" IN (${Prisma.join(followingIds)}) AND p."deletedAt" IS NULL
      UNION ALL
      SELECT p."repostedPostId" AS "postId", p."userId", p."createdAt" FROM "Post" p
      WHERE p."repostedPostId" IN (${Prisma.join(postIds)}) AND p."userId" IN (${Prisma.join(followingIds)}) AND p."deletedAt" IS NULL AND p."kind" = 'repost'
    ) e
    GROUP BY e."postId"
  `;
}
