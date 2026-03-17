import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { NotificationsService } from '../notifications/notifications.service';

const VIEW_MILESTONES = [50, 100, 500, 1000] as const;

function nextMilestone(currentCount: number, lastNotified: number | null): number | null {
  const alreadyNotified = lastNotified ?? 0;
  for (const m of VIEW_MILESTONES) {
    if (currentCount >= m && m > alreadyNotified) return m;
  }
  return null;
}

@Injectable()
export class ArticlesTrendingScoreCron {
  private readonly logger = new Logger(ArticlesTrendingScoreCron.name);
  private running = false;
  private milestoneRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Compute trending scores for articles every 10 minutes.
   * Score formula uses a 36-hour half-life (articles trend longer than posts).
   * Components: boostCount * decay + commentCount * 0.8 * decay + shareCount * 0.5 * decay + ln(1+weightedViewCount) * 0.35 * decay
   * We use a logarithmic view term so views inform ranking without overpowering stronger engagement signals.
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
              a."boostCount" * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (36 * 60 * 60)))
              + a."commentCount" * 0.8 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (36 * 60 * 60)))
              + COALESCE(sc."shareCount", 0) * 0.5 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (36 * 60 * 60)))
              + LN(1 + COALESCE(a."weightedViewCount", 0)::double precision) * 0.35 * POWER(0.5, GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - a."publishedAt")) / (36 * 60 * 60)))
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

  /** Enqueue article view milestone sweep every 30 minutes. */
  @Cron('*/30 * * * *')
  async scheduleViewMilestoneSweep() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.articlesViewMilestoneSweep, {}, 'cron-articlesViewMilestoneSweep', {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5 * 60_000 },
      });
    } catch {
      // likely duplicate jobId; treat as no-op
    }
  }

  /**
   * For each published article that has crossed a view milestone (50/100/500/1000)
   * that hasn't been notified yet, send a generic in-app + push notification to the author.
   */
  async runViewMilestoneSweep(): Promise<void> {
    if (this.milestoneRunning) return;
    this.milestoneRunning = true;
    const startedAt = Date.now();
    let total = 0;

    try {
      // Pull published articles that have views and might have crossed a new milestone.
      // Limit to articles with at least 50 views and whose last-notified milestone may be stale.
      const articles = await this.prisma.article.findMany({
        where: {
          isDraft: false,
          deletedAt: null,
          publishedAt: { not: null },
          viewCount: { gte: VIEW_MILESTONES[0] },
        },
        select: {
          id: true,
          title: true,
          viewCount: true,
          viewMilestoneNotified: true,
          authorId: true,
        },
      });

      for (const article of articles) {
        const milestone = nextMilestone(article.viewCount, article.viewMilestoneNotified);
        if (!milestone) continue;

        // Atomically mark this milestone so concurrent runs don't double-notify.
        const updated = await this.prisma.article.updateMany({
          where: {
            id: article.id,
            OR: [
              { viewMilestoneNotified: null },
              { viewMilestoneNotified: { lt: milestone } },
            ],
          },
          data: { viewMilestoneNotified: milestone },
        });
        if (updated.count !== 1) continue; // already handled by another run

        const titleSnippet = (article.title ?? 'Your article').slice(0, 80).trim();
        const body = `${titleSnippet} has been read ${milestone.toLocaleString()} time${milestone === 1 ? '' : 's'}.`;

        await this.notifications.create({
          recipientUserId: article.authorId,
          actorUserId: null,
          kind: 'generic',
          title: `${milestone.toLocaleString()} views`,
          body,
          subjectArticleId: article.id,
          subjectPostId: null,
        });

        total++;
      }

      if (total > 0) {
        this.logger.log(`[article-milestones] Notified authors for ${total} milestone(s) in ${Date.now() - startedAt}ms`);
      }
    } catch (err) {
      this.logger.error(
        `[article-milestones] Sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.milestoneRunning = false;
    }
  }
}
