import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { POSTS_RANKING } from './posts-ranking.config';

/**
 * Post ranking scores: boost-score freshness, the popular/trending score
 * formula, and single-post score refresh (cron + BullMQ entry points).
 *
 * Feed assembly (popular / featured / for-you ordering) still lives in
 * PostsService; this service owns the underlying score computation.
 */
@Injectable()
export class PostsRankingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  async ensureBoostScoresFresh(postIds: string[]) {
    const ids = (postIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();

    const now = new Date();
    const staleBefore = new Date(now.getTime() - POSTS_RANKING.boostScoreTtlMs);

    const posts = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScoreUpdatedAt: true },
    });

    const staleIds = posts
      .filter((p) => !p.boostScoreUpdatedAt || p.boostScoreUpdatedAt < staleBefore)
      .map((p) => p.id);

    if (staleIds.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ postId: string; score: number | null }>>(Prisma.sql`
        SELECT
          b."postId" as "postId",
          CAST(
            SUM(
              (
                CASE
                  WHEN u."premium" THEN 3
                  WHEN u."verifiedStatus" <> 'none' THEN 2
                  ELSE 1
                END
              )
              * POWER(
                0.5,
                EXTRACT(EPOCH FROM (NOW() - b."createdAt")) / (24 * 60 * 60)
              )
            ) AS DOUBLE PRECISION
          ) as "score"
        FROM "Boost" b
        JOIN "User" u ON u."id" = b."userId"
        WHERE b."postId" IN (${Prisma.join(staleIds)})
        GROUP BY b."postId"
      `);

      const scoreByPostId = new Map<string, number>();
      for (const r of rows) scoreByPostId.set(r.postId, r.score ?? 0);

      const tuples = staleIds.map((id) => Prisma.sql`(${id}, ${scoreByPostId.get(id) ?? 0})`);
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "Post" AS p
        SET
          "boostScore" = v.score,
          "boostScoreUpdatedAt" = ${now}
        FROM (VALUES ${Prisma.join(tuples)}) AS v(id, score)
        WHERE p."id" = v.id
      `);
    }

    const refreshed = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScore: true, boostScoreUpdatedAt: true },
    });

    const out = new Map<string, { boostScore: number | null; boostScoreUpdatedAt: Date | null }>();
    for (const p of refreshed) out.set(p.id, { boostScore: p.boostScore ?? null, boostScoreUpdatedAt: p.boostScoreUpdatedAt });
    return out;
  }

  /**
   * Computes the overall popularity score for given post IDs (same formula as popular feed).
   * Call ensureBoostScoresFresh first so boostScore is up to date.
   */
  async computeScoresForPostIds(postIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set((postIds ?? []).filter(Boolean))];
    if (ids.length === 0) return new Map<string, number>();

    const snapshotAsOf = new Date();
    const lookbackMs = POSTS_RANKING.popularLookbackDays * 24 * 60 * 60 * 1000;
    const snapshotMinCreatedAt = new Date(snapshotAsOf.getTime() - lookbackMs);

    const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
      WITH
      commenter_latest AS (
        SELECT
          p."parentId" as "postId",
          p."userId" as "userId",
          MAX(p."createdAt") as "latestAt"
        FROM "Post" p
        WHERE
          p."parentId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}`))})
          AND p."deletedAt" IS NULL
          AND p."createdAt" >= ${snapshotMinCreatedAt}
        GROUP BY p."parentId", p."userId"
      ),
      comment_scores AS (
        SELECT
          cl."postId" as "postId",
          CAST(
            SUM(
              POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - cl."latestAt"))
                ) / ${POSTS_RANKING.popularHalfLifeSeconds}
              )
            ) AS DOUBLE PRECISION
          ) as "commentScore"
        FROM commenter_latest cl
        GROUP BY cl."postId"
      ),
      scored AS (
        SELECT
          p."id" as "id",
          CAST(
            (
              CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore" * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                  ) / ${POSTS_RANKING.popularHalfLifeSeconds}
                )
              END
            )
            +
            (
              (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                0.5,
                GREATEST(
                  0,
                  EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))
                ) / ${POSTS_RANKING.popularHalfLifeSeconds}
              )
            )
            +
            (
              -- commentScore decayed by both comment recency AND post age (72h half-life for post age).
              (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight}
              * POWER(
                0.5,
                GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / (72 * 60 * 60)
              )
            )
            +
            (
              -- Poll votes: direct engagement signal, decayed by post age like bookmarks.
              COALESCE(poll."totalVoteCount", 0)::DOUBLE PRECISION * 0.3 * POWER(
                0.5,
                GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.popularHalfLifeSeconds}
              )
            )
            +
            (
              CASE
                WHEN p."kind" = 'checkin' THEN
                  0.08
                  * LEAST(
                    1.0,
                    GREATEST(
                      0.0,
                      (CHAR_LENGTH(COALESCE(TRIM(p."body"), '')) - 60)::DOUBLE PRECISION / 240.0
                    )
                  )
                  * POWER(
                    0.5,
                    GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.popularHalfLifeSeconds}
                  )
                ELSE 0
              END
            )
            +
            (
              CASE
                WHEN u."pinnedPostId" = p."id" THEN
                  (CASE WHEN u."premium" THEN ${POSTS_RANKING.pinScorePremium} WHEN u."verifiedStatus" <> 'none' THEN ${POSTS_RANKING.pinScoreVerified} ELSE ${POSTS_RANKING.pinScoreBase} END)
                  * POWER(
                    0.5,
                    GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt"))) / ${POSTS_RANKING.popularHalfLifeSeconds}
                  )
                ELSE 0
              END
            )
            * (CASE WHEN p."parentId" IS NULL THEN ${POSTS_RANKING.popularTopLevelScoreBoost} ELSE 1.0 END)
            * (CASE WHEN p."kind" = 'checkin' THEN 0.85 ELSE 1.0 END)
            * (
              CASE
                WHEN u."verifiedStatus" = 'none' AND u."createdAt" >= (${snapshotAsOf}::timestamptz - INTERVAL '7 days') THEN 0.85
                ELSE 1.0
              END
            )
            * POWER(
              ${POSTS_RANKING.deletedAncestorPenalty},
              (
                (CASE WHEN parent."deletedAt" IS NOT NULL THEN 1 ELSE 0 END)
                +
                (CASE
                  WHEN root."deletedAt" IS NOT NULL AND (parent."id" IS NULL OR root."id" <> parent."id") THEN 1
                  ELSE 0
                END)
              )
            )
            * (
              1 + LEAST(
                ${POSTS_RANKING.popularEngagementRateCap},
                ${POSTS_RANKING.popularEngagementRateWeight} * (
                  (
                    CASE WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                    ELSE p."boostScore" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})) END
                  )
                  +
                  ((p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${snapshotAsOf}::timestamptz - p."createdAt")) / ${POSTS_RANKING.popularHalfLifeSeconds})))
                  +
                  ((COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight})
                ) / GREATEST((p."weightedViewCount" + ${POSTS_RANKING.popularEngagementRateK})::DOUBLE PRECISION, ${POSTS_RANKING.popularEngagementRateK}::DOUBLE PRECISION)
              )
            )
            AS DOUBLE PRECISION
          ) as "score"
        FROM "Post" p
        LEFT JOIN "User" u ON u."id" = p."userId"
        LEFT JOIN "Post" parent ON parent."id" = p."parentId"
        LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
        LEFT JOIN comment_scores cs ON cs."postId" = p."id"
        LEFT JOIN "PostPoll" poll ON poll."postId" = p."id"
        WHERE p."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}`))})
      )
      SELECT "id", "score" FROM scored
    `);

    return new Map(rows.map((r) => [r.id, r.score]));
  }

  /**
   * Recompute and persist the trendingScore for a single post.
   * Called by the per-post BullMQ refresh job so scores update within seconds of engagement.
   */
  async refreshAndStoreTrendingScore(postId: string): Promise<void> {
    if (!postId) return;
    await this.ensureBoostScoresFresh([postId]);
    const scores = await this.computeScoresForPostIds([postId]);
    const score = scores.get(postId) ?? 0;
    await this.prisma.post.update({
      where: { id: postId },
      data: {
        trendingScore: score > 0 ? score : null,
        trendingScoreUpdatedAt: new Date(),
      },
    });
  }

  /**
   * Fire-and-forget: enqueue a deduplicated BullMQ job to refresh a post's trending score.
   * Uses a stable job ID so multiple rapid engagements collapse into one refresh.
   */
  enqueueScoreRefresh(postId: string): void {
    if (!postId) return;
    this.jobs
      .enqueue(
        JOBS.postsRefreshSinglePostScore,
        { postId },
        { jobId: `score-${postId}`, removeOnComplete: true, removeOnFail: true },
      )
      .catch(() => {});
  }
}
