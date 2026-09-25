import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type {
  AdminAnalyticsBoardDto,
  AnalyticsGranularity,
} from "../../common/dto/admin-analytics.dto";

/** Live Board rows by people (bots excluded), minus article mirrors. */
const boardRows = Prisma.sql`
  FROM "Post" p
  JOIN "User" u ON u.id = p."userId" AND u."isBot" = false
  WHERE p."kind" = 'board'
    AND p."deletedAt" IS NULL
    AND p."isDraft" = false
    AND p."articleId" IS NULL
`;

function toTimeSeries(rows: Array<{ bucket: Date; count: bigint }>) {
  return rows.map((r) => ({
    bucket: r.bucket.toISOString().split("T")[0]!,
    count: Number(r.count),
  }));
}

export async function readBoardAnalytics(
  prisma: PrismaService,
  opts: { since: Date | null; granularity: AnalyticsGranularity },
): Promise<AdminAnalyticsBoardDto> {
  const { since, granularity } = opts;
  const inRange = (col: Prisma.Sql) =>
    since ? Prisma.sql`AND ${col} >= ${since}::timestamptz` : Prisma.sql``;

  const [summaryRaw, visibilityRaw, threadSeriesRaw, commentSeriesRaw, boostsRaw, answeredRaw, topRaw] =
    await Promise.all([
      prisma.$queryRaw<
        Array<{
          total_threads: bigint;
          total_comments: bigint;
          threads_in_range: bigint;
          comments_in_range: bigint;
          participants_in_range: bigint;
        }>
      >(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE p."parentId" IS NULL)::bigint AS total_threads,
          COUNT(*) FILTER (WHERE p."parentId" IS NOT NULL)::bigint AS total_comments,
          COUNT(*) FILTER (WHERE p."parentId" IS NULL ${since ? Prisma.sql`AND p."createdAt" >= ${since}::timestamptz` : Prisma.sql``})::bigint AS threads_in_range,
          COUNT(*) FILTER (WHERE p."parentId" IS NOT NULL ${since ? Prisma.sql`AND p."createdAt" >= ${since}::timestamptz` : Prisma.sql``})::bigint AS comments_in_range,
          COUNT(DISTINCT p."userId") FILTER (WHERE ${since ? Prisma.sql`p."createdAt" >= ${since}::timestamptz` : Prisma.sql`true`})::bigint AS participants_in_range
        ${boardRows}
      `),
      prisma.$queryRaw<Array<{ visibility: string; cnt: bigint }>>(Prisma.sql`
        SELECT p."visibility"::text AS visibility, COUNT(*)::bigint AS cnt
        ${boardRows}
          AND p."parentId" IS NULL
        GROUP BY 1
      `),
      prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, p."createdAt") AS bucket, COUNT(*)::bigint AS count
        ${boardRows}
          AND p."parentId" IS NULL
          ${inRange(Prisma.sql`p."createdAt"`)}
        GROUP BY 1 ORDER BY 1
      `),
      prisma.$queryRaw<Array<{ bucket: Date; count: bigint }>>(Prisma.sql`
        SELECT DATE_TRUNC(${granularity}, p."createdAt") AS bucket, COUNT(*)::bigint AS count
        ${boardRows}
          AND p."parentId" IS NOT NULL
          ${inRange(Prisma.sql`p."createdAt"`)}
        GROUP BY 1 ORDER BY 1
      `),
      prisma.$queryRaw<Array<{ cnt: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
        FROM "Boost" b
        JOIN "Post" p ON p.id = b."postId"
        WHERE p."kind" = 'board'
          AND p."deletedAt" IS NULL
          ${inRange(Prisma.sql`b."createdAt"`)}
      `),
      prisma.$queryRaw<Array<{ total: bigint; answered: bigint }>>(Prisma.sql`
        WITH threads AS (
          SELECT p.id, p."createdAt"
          ${boardRows}
            AND p."parentId" IS NULL
            ${inRange(Prisma.sql`p."createdAt"`)}
        )
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM "Post" c
            WHERE c."rootId" = threads.id
              AND c."deletedAt" IS NULL
              AND c."createdAt" <= threads."createdAt" + INTERVAL '24 hours'
          ))::bigint AS answered
        FROM threads
      `),
      prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          visibility: string;
          author_username: string | null;
          boost_count: number;
          comment_count: number;
          viewer_count: number;
          total_view_count: number;
          created_at: Date;
        }>
      >(Prisma.sql`
        SELECT p.id, t.title, p."visibility"::text AS visibility, u.username AS author_username,
               p."boostCount" AS boost_count, p."commentCount" AS comment_count,
               p."viewerCount" AS viewer_count, p."totalViewCount" AS total_view_count,
               p."createdAt" AS created_at
        FROM "Post" p
        JOIN "BoardThread" t ON t."postId" = p.id
        JOIN "User" u ON u.id = p."userId" AND u."isBot" = false
        WHERE p."kind" = 'board'
          AND p."deletedAt" IS NULL
          AND p."isDraft" = false
          AND p."articleId" IS NULL
          AND p."parentId" IS NULL
          ${inRange(Prisma.sql`p."createdAt"`)}
        ORDER BY p."boostCount" DESC, p."commentCount" DESC, p."createdAt" DESC
        LIMIT 10
      `),
    ]);

  const summary = summaryRaw[0];
  const answered = answeredRaw[0];
  const totalInRange = Number(answered?.total ?? 0);

  return {
    totalThreads: Number(summary?.total_threads ?? 0),
    totalComments: Number(summary?.total_comments ?? 0),
    threadsInRange: Number(summary?.threads_in_range ?? 0),
    commentsInRange: Number(summary?.comments_in_range ?? 0),
    participantsInRange: Number(summary?.participants_in_range ?? 0),
    boostsInRange: Number(boostsRaw[0]?.cnt ?? 0),
    pctThreadsWithCommentWithin24h:
      totalInRange > 0
        ? Math.round((1000 * Number(answered?.answered ?? 0)) / totalInRange) / 10
        : null,
    byVisibility: Object.fromEntries(visibilityRaw.map((r) => [r.visibility, Number(r.cnt)])),
    threads: toTimeSeries(threadSeriesRaw),
    comments: toTimeSeries(commentSeriesRaw),
    topThreads: topRaw.map((r) => ({
      id: r.id,
      title: r.title,
      visibility: r.visibility,
      authorUsername: r.author_username,
      boostCount: Number(r.boost_count),
      commentCount: Number(r.comment_count),
      uniqueViewCount: Number(r.viewer_count),
      viewCount: Math.max(Number(r.viewer_count), Number(r.total_view_count)),
      createdAt: r.created_at.toISOString(),
    })),
  };
}
