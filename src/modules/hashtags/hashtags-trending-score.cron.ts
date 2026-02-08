import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HashtagsTrendingScoreCron implements OnModuleInit {
  private readonly logger = new Logger(HashtagsTrendingScoreCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Kick an initial refresh shortly after boot so new envs don't show empty trends for ~10 minutes.
    const t = setTimeout(async () => {
      try {
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
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const asOf = new Date();
      const halfLifeHours = 12;
      const halfLifeSeconds = halfLifeHours * 60 * 60;

      const queryRows = async (lookbackDays: number) => {
        const minCreatedAt = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
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
            AND p."parentId" IS NULL
            AND p."visibility" <> 'onlyMe'
            AND CARDINALITY(p."hashtags") > 0
          GROUP BY 1, 2
          HAVING LOWER(TRIM(t)) <> ''
          ORDER BY "score" DESC, "usageCount" DESC, "tag" ASC
          LIMIT 20000
        `);
      };

      // Primary: true “trending” (2-week lookback). Fallback: if sparse data yields nothing, widen so UI isn't empty.
      const rows14 = await queryRows(14);
      const rows = rows14.length > 0 ? rows14 : await queryRows(365);

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
      this.logger.log(`Refreshed hashtag trending snapshots: ${rows.length} rows asOf=${asOf.toISOString()} (${ms}ms)`);
    } catch (err) {
      this.logger.warn(`Hashtag trending snapshot refresh failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

