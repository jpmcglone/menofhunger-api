import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { postRankingSql } from './posts-ranking.sql';
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

    const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(
      postRankingSql(Prisma.sql`SELECT p."id" FROM "Post" p WHERE p."id" IN (${Prisma.join(ids)})`, new Date()),
    );

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
