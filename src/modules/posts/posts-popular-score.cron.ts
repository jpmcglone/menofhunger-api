import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from './posts.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { postRankingSql } from './posts-ranking.sql';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class PostsPopularScoreCron {
  private readonly logger = new Logger(PostsPopularScoreCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Periodically precompute trending scores into Postgres.
   * This is "caching without Redis": request-time only does a fast indexed read.
   */
  @Cron('*/10 * * * *')
  async refreshPopularSnapshots() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.postsPopularScoreRefresh, {}, 'cron-postsPopularScoreRefresh', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch (err) {
      this.logger.debug(`Popular score refresh enqueue skipped: ${(err as Error).message}`);
    }
  }

  async runRefreshPopularSnapshots() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const asOf = new Date();
      const lookbackDays = 30;
      const minCreatedAt = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
      // asOf is used both as the scoring reference time and as the trendingScoreUpdatedAt timestamp.

      // Warm up boostScore for likely-top boosted posts so scoring uses fresh boostScore.
      const staleBefore = new Date(asOf.getTime() - 10 * 60 * 1000);
      const warmup = await this.prisma.post.findMany({
        where: {
          AND: [
            { deletedAt: null },
            { parentId: null },
            { visibility: { not: 'onlyMe' } },
            { createdAt: { gte: minCreatedAt } },
            { boostCount: { gt: 0 } },
            { OR: [{ boostScoreUpdatedAt: null }, { boostScoreUpdatedAt: { lt: staleBefore } }] },
          ],
        },
        orderBy: [{ boostCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: { id: true },
      });
      if (warmup.length > 0) {
        await this.posts.ensureBoostScoresFresh(warmup.map((p) => p.id));
      }

      // Compute trending scores for all candidate posts, then write directly to Post.trendingScore.
      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(
        postRankingSql(Prisma.sql`
          SELECT u."id" as "id"
          FROM (
            (
              -- Recency bucket: include recent posts even with no engagement.
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND p."createdAt" >= ${new Date(asOf.getTime() - 72 * 60 * 60 * 1000)}
              ORDER BY p."createdAt" DESC, p."id" DESC
              LIMIT 8000
            )
            UNION
            (
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND p."boostCount" > 0
              ORDER BY p."boostCount" DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 1500
            )
            UNION
            (
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND p."bookmarkCount" > 0
              ORDER BY p."bookmarkCount" DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 1500
            )
            UNION
            (
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND p."commentCount" > 0
              ORDER BY p."commentCount" DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 1500
            )
            UNION
            (
              -- Posts that have been reposted are signals of content spread/virality.
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND p."repostCount" > 0
              ORDER BY p."repostCount" DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 1500
            )
            UNION
            (
              -- Replies with engagement can become popular; top-level posts get a slight boost in scoring.
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NOT NULL
                AND p."createdAt" >= ${minCreatedAt}
                AND (p."boostCount" > 0 OR p."bookmarkCount" > 0)
              ORDER BY (p."boostCount" + p."bookmarkCount") DESC, p."createdAt" DESC, p."id" DESC
              LIMIT 1200
            )
            UNION
            (
              -- Community group roots: dedicated quota so they are scored even when they miss the
              -- global top-N recency window (group trending reads Post.trendingScore like elsewhere).
              SELECT p."id"
              FROM "Post" p
              WHERE
                p."deletedAt" IS NULL
                AND p."visibility" <> 'onlyMe'
                AND p."parentId" IS NULL
                AND p."communityGroupId" IS NOT NULL
                AND p."createdAt" >= ${minCreatedAt}
              ORDER BY p."createdAt" DESC, p."id" DESC
              LIMIT 4000
            )
          ) u
          JOIN "Post" _nog ON _nog."id" = u."id"
          GROUP BY u."id"
`, asOf),
      );

      // Bulk-update Post.trendingScore in chunks using a VALUES table join for efficiency.
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = chunk.map((r) => Prisma.sql`(${r.id}, ${r.score}::double precision)`);
        await this.prisma.$executeRaw`
          UPDATE "Post" AS p
          SET "trendingScore" = NULLIF(v.score, 0),
              "trendingScoreUpdatedAt" = ${asOf}::timestamptz
          FROM (VALUES ${Prisma.join(values)}) AS v(id, score)
          WHERE p."id" = v.id
        `;
      }

      // Reset posts older than the lookback window that still carry a stale score.
      await this.prisma.post.updateMany({
        where: {
          trendingScore: { gt: 0 },
          createdAt: { lt: minCreatedAt },
        },
        data: { trendingScore: null, trendingScoreUpdatedAt: asOf },
      });

      const ms = Date.now() - startedAt;
      this.logger.log(`Refreshed trending scores: ${rows.length} posts updated (${ms}ms)`);
    } catch (err) {
      this.logger.warn(`Trending snapshot refresh failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

