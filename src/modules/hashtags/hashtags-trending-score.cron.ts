import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
import { AppConfigService } from '../app/app-config.service';

@Injectable()
export class HashtagsTrendingScoreCron implements OnModuleInit {
  private readonly logger = new Logger(HashtagsTrendingScoreCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit() {
    // Kick an initial refresh shortly after boot so new envs don't show empty trends for ~10 minutes.
    const t = setTimeout(async () => {
      try {
        if (!this.appConfig.runSchedulers()) return;
        const latest = await this.prisma.hashtagTrendingScoreSnapshot.findFirst({
          orderBy: [{ asOf: 'desc' }],
          select: { asOf: true },
        });
        const asOf = latest?.asOf ?? null;
        const staleMs = 12 * 60 * 1000;
        const isStale = !asOf || Date.now() - asOf.getTime() > staleMs;
        if (isStale) {
          await this.refreshTrendingHashtagSnapshots();
        }
      } catch (err) {
        this.logger.warn(`Initial hashtag trending refresh skipped: ${(err as Error).message}`);
      }
    }, 4000);
    // Don't keep the process open just for this.
    (t as any)?.unref?.();
  }

  /**
   * Periodically precompute trending hashtag scores into Postgres.
   * This is "caching without Redis": request-time is just an indexed read.
   */
  @Cron('*/10 * * * *')
  async refreshTrendingHashtagSnapshots() {
    if (!this.appConfig.runSchedulers()) return;
    try {
      await this.jobs.enqueueCron(JOBS.hashtagsTrendingScoreRefresh, {}, 'cron:hashtagsTrendingScoreRefresh', {
        attempts: 2,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    } catch {
      // likely duplicate jobId while previous run is active; treat as no-op
    }
  }

  async runRefreshTrendingHashtagSnapshots() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const asOf = new Date();
      const halfLifeHours = 12;
      const halfLifeSeconds = halfLifeHours * 60 * 60;

      const queryRows = async (params: { lookbackDays: number; topLevelOnly: boolean }) => {
        const minCreatedAt = new Date(asOf.getTime() - params.lookbackDays * 24 * 60 * 60 * 1000);
        const topLevelSql = params.topLevelOnly ? Prisma.sql`AND p."parentId" IS NULL` : Prisma.sql``;
        return await this.prisma.$queryRaw<
          Array<{
            visibility: 'public' | 'verifiedOnly' | 'premiumOnly';
            tag: string;
            score: number;
            usageCount: number;
          }>
        >(Prisma.sql`
          SELECT
            p."visibility" as "visibility",
            LOWER(TRIM(t)) as "tag",
            CAST(
              SUM(
                POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / ${halfLifeSeconds}
                )
              ) AS DOUBLE PRECISION
            ) as "score",
            CAST(COUNT(*) AS INT) as "usageCount"
          FROM "Post" p
          CROSS JOIN LATERAL UNNEST(p."hashtags") AS t
          WHERE
            p."deletedAt" IS NULL
            AND p."createdAt" >= ${minCreatedAt}
            ${topLevelSql}
            AND p."visibility" <> 'onlyMe'
            AND CARDINALITY(p."hashtags") > 0
          GROUP BY 1, 2
          HAVING LOWER(TRIM(t)) <> ''
          ORDER BY "score" DESC, "usageCount" DESC, "tag" ASC
          LIMIT 20000
        `);
      };

      // Primary: true “trending” (2-week lookback, top-level only).
      // Fallbacks are intentionally more permissive so the UI doesn't show "No trends yet" forever on sparse datasets.
      const rows14 = await queryRows({ lookbackDays: 14, topLevelOnly: true });
      const rows3650Top = rows14.length === 0 ? await queryRows({ lookbackDays: 3650, topLevelOnly: true }) : [];
      const rows3650All = rows14.length === 0 && rows3650Top.length === 0 ? await queryRows({ lookbackDays: 3650, topLevelOnly: false }) : [];
      const rows = rows14.length > 0 ? rows14 : rows3650Top.length > 0 ? rows3650Top : rows3650All;

      const cutoff = new Date(asOf.getTime() - 60 * 60 * 1000);

      await this.prisma.$transaction(async (tx) => {
        await tx.hashtagTrendingScoreSnapshot.deleteMany({ where: { asOf: { lt: cutoff } } });
        await tx.hashtagTrendingScoreSnapshot.deleteMany({ where: { asOf } });

        const chunkSize = 1000;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          await tx.hashtagTrendingScoreSnapshot.createMany({
            data: chunk.map((r) => ({
              asOf,
              visibility: r.visibility,
              tag: r.tag,
              score: r.score,
              usageCount: r.usageCount ?? 0,
            })),
          });
        }
      });

      const ms = Date.now() - startedAt;
      const mode = rows14.length > 0 ? '14d-top' : rows3650Top.length > 0 ? '3650d-top' : '3650d-all';
      this.logger.log(
        `Refreshed hashtag trending snapshots: ${rows.length} rows asOf=${asOf.toISOString()} mode=${mode} (${ms}ms)`,
      );
    } catch (err) {
      this.logger.warn(`Hashtag trending snapshot refresh failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

