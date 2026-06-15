import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Refresh tier-weighted article boost scores at most this often. */
const ARTICLE_BOOST_SCORE_TTL_MS = 10 * 60 * 1000;

/**
 * Article ranking scores: tier-weighted boost-score freshness.
 *
 * Mirrors PostsRankingService.ensureBoostScoresFresh but for articles. The
 * weighted score is a tier-weighted COUNT of boosts (premium 3 / verified 2 /
 * unverified 1) — no per-boost time decay — so the article trending cron's
 * existing article-age decay model is unchanged; only the magnitude of the
 * boost signal is discounted for unverified boosters.
 */
@Injectable()
export class ArticlesRankingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ensure `Article.boostScore` is fresh (within TTL) for the given article ids.
   * Recomputes stale rows from ArticleBoost JOIN User and persists the result.
   */
  async ensureArticleBoostScoresFresh(articleIds: string[]): Promise<void> {
    const ids = [...new Set((articleIds ?? []).filter(Boolean))];
    if (ids.length === 0) return;

    const now = new Date();
    const staleBefore = new Date(now.getTime() - ARTICLE_BOOST_SCORE_TTL_MS);

    const articles = await this.prisma.article.findMany({
      where: { id: { in: ids } },
      select: { id: true, boostScoreUpdatedAt: true },
    });

    const staleIds = articles
      .filter((a) => !a.boostScoreUpdatedAt || a.boostScoreUpdatedAt < staleBefore)
      .map((a) => a.id);

    if (staleIds.length === 0) return;

    const rows = await this.prisma.$queryRaw<Array<{ articleId: string; score: number | null }>>(Prisma.sql`
      SELECT
        b."articleId" as "articleId",
        CAST(
          SUM(
            CASE
              WHEN u."premium" THEN 3
              WHEN u."verifiedStatus" <> 'none' THEN 2
              ELSE 1
            END
          ) AS DOUBLE PRECISION
        ) as "score"
      FROM "ArticleBoost" b
      JOIN "User" u ON u."id" = b."userId"
      WHERE b."articleId" IN (${Prisma.join(staleIds)})
      GROUP BY b."articleId"
    `);

    const scoreByArticleId = new Map<string, number>();
    for (const r of rows) scoreByArticleId.set(r.articleId, r.score ?? 0);

    const tuples = staleIds.map((id) => Prisma.sql`(${id}, ${scoreByArticleId.get(id) ?? 0})`);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Article" AS a
      SET
        "boostScore" = v.score,
        "boostScoreUpdatedAt" = ${now}
      FROM (VALUES ${Prisma.join(tuples)}) AS v(id, score)
      WHERE a."id" = v.id
    `);
  }
}
