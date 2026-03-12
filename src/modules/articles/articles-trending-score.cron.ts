import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class ArticlesTrendingScoreCron {
  private readonly logger = new Logger(ArticlesTrendingScoreCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Compute trending scores for articles every 10 minutes.
   * Score formula uses a 24-hour half-life (articles trend longer than posts).
   * Components: boostCount * decay + commentCount * 0.8 * decay + shareCount * 0.5 * decay + weightedViewCount * 0.2 * decay
   */
  @Cron('*/10 * * * *')
  async refreshTrendingScores() {
    if (!this.appConfig.runSchedulers()) return;
    if (this.running) return;
    this.running = true;

    const startedAt = Date.now();
    try {
      const asOf = new Date();
      const lookbackDays = 14;
      const minPublishedAt = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        WITH share_counts AS (
          SELECT
            p."articleId" as "articleId",
            COUNT(*) as "shareCount"
          FROM "Post" p
          WHERE
            p."articleId" IS NOT NULL
            AND p."kind" = 'articleShare'
            AND p."deletedAt" IS NULL
            AND p."createdAt" >= ${minPublishedAt}
          GROUP BY p."articleId"
        ),
        scored AS (
          SELECT
            a."id",
            (
              a."boostCount" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (24 * 60 * 60)))
              + a."commentCount" * 0.8 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (24 * 60 * 60)))
              + COALESCE(sc."shareCount", 0) * 0.5 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (24 * 60 * 60)))
              + COALESCE(a."weightedViewCount", 0) * 0.2 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (24 * 60 * 60)))
            )::double precision as "score"
          FROM "Article" a
          LEFT JOIN share_counts sc ON sc."articleId" = a."id"
          WHERE
            a."isDraft" = false
            AND a."deletedAt" IS NULL
            AND a."publishedAt" IS NOT NULL
            AND a."publishedAt" >= ${minPublishedAt}
        )
        SELECT id, score FROM scored WHERE score > 0 ORDER BY score DESC LIMIT 1000
      `);

      if (rows.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          await this.prisma.$transaction(
            batch.map((row) =>
              this.prisma.article.update({
                where: { id: row.id },
                data: { trendingScore: row.score, trendingScoreUpdatedAt: asOf },
              }),
            ),
          );
        }
      }

      const activeIds = rows.map((r) => r.id);
      if (activeIds.length > 0) {
        await this.prisma.article.updateMany({
          where: {
            trendingScore: { not: null },
            id: { notIn: activeIds },
            OR: [
              { publishedAt: { lt: minPublishedAt } },
              { publishedAt: null },
            ],
          },
          data: { trendingScore: null, trendingScoreUpdatedAt: asOf },
        });
      } else {
        await this.prisma.article.updateMany({
          where: { trendingScore: { not: null } },
          data: { trendingScore: null, trendingScoreUpdatedAt: asOf },
        });
      }

      this.logger.log(
        `Article trending scores refreshed: ${rows.length} articles in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      this.logger.error(
        `Article trending score refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
