import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from './posts.service';

@Injectable()
export class PostsPopularScoreCron {
  private readonly logger = new Logger(PostsPopularScoreCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
  ) {}

  /**
   * Periodically precompute trending scores into Postgres.
   * This is "caching without Redis": request-time only does a fast indexed read.
   */
  @Cron('*/10 * * * *')
  async refreshPopularSnapshots() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const asOf = new Date();
      const lookbackDays = 30;
      const minCreatedAt = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

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

      // Compute scored candidates (same formula as request-time trending feed).
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          createdAt: Date;
          score: number;
          userId: string;
          visibility: 'public' | 'verifiedOnly' | 'premiumOnly' | 'onlyMe';
          parentId: string | null;
          rootId: string | null;
        }>
      >(Prisma.sql`
        WITH
        comment_scores AS (
          SELECT
            p."parentId" as "postId",
            CAST(
              SUM(
                POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (12 * 60 * 60)
                )
              ) AS DOUBLE PRECISION
            ) as "commentScore"
          FROM "Post" p
          WHERE
            p."parentId" IS NOT NULL
            AND p."deletedAt" IS NULL
            AND p."createdAt" >= ${minCreatedAt}
          GROUP BY p."parentId"
        ),
        candidates AS (
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
          ) u
          GROUP BY u."id"
        ),
        latest_hashtag_snapshot AS (
          SELECT (
            SELECT s."asOf"
            FROM "HashtagTrendingScoreSnapshot" s
            ORDER BY s."asOf" DESC
            LIMIT 1
          ) as "asOf"
        ),
        hashtag_global AS (
          SELECT
            CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxScore"
          FROM "HashtagTrendingScoreSnapshot" h
          JOIN latest_hashtag_snapshot lhs ON TRUE
          WHERE
            lhs."asOf" IS NOT NULL
            AND h."asOf" = lhs."asOf"
            AND h."visibility" IN ('public'::"PostVisibility", 'verifiedOnly'::"PostVisibility", 'premiumOnly'::"PostVisibility")
        ),
        post_hashtag_scores AS (
          SELECT
            p."id" as "postId",
            CAST(MAX(h."score") AS DOUBLE PRECISION) as "maxTagScore"
          FROM "Post" p
          JOIN candidates c ON c."id" = p."id"
          CROSS JOIN LATERAL UNNEST(p."hashtags") AS t
          JOIN latest_hashtag_snapshot lhs ON TRUE
          LEFT JOIN "HashtagTrendingScoreSnapshot" h ON
            lhs."asOf" IS NOT NULL
            AND h."asOf" = lhs."asOf"
            AND h."visibility" = p."visibility"
            AND h."tag" = LOWER(TRIM(t))
          WHERE LOWER(TRIM(t)) <> ''
          GROUP BY p."id"
        ),
        scored AS (
          SELECT
            p."id" as "id",
            p."createdAt" as "createdAt",
            p."userId" as "userId",
            p."visibility" as "visibility",
            p."parentId" as "parentId",
            p."rootId" as "rootId",
            CAST(
              (
                CASE
                WHEN p."boostScore" IS NULL OR p."boostScoreUpdatedAt" IS NULL THEN 0
                ELSE p."boostScore" * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (12 * 60 * 60)
                )
                END
              )
              +
              (
                (p."bookmarkCount"::DOUBLE PRECISION) * 0.5 * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (12 * 60 * 60)
                )
              )
              +
              (
                (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * 0.5
              )
              +
              (
                CASE
                  WHEN hs."maxTagScore" IS NULL OR hs."maxTagScore" <= 0 THEN 0
                  ELSE
                    0.05
                    +
                    COALESCE(
                      LEAST(
                        1.0,
                        hs."maxTagScore" / NULLIF(hg."maxScore", 0)
                      ),
                      0
                    ) * 0.15
                END
              )
              +
              (
                CASE
                  WHEN u."pinnedPostId" = p."id" THEN
                    (CASE WHEN u."premium" THEN 0.5 WHEN u."verifiedStatus" <> 'none' THEN 0.3 ELSE 0.15 END)
                    * POWER(
                      0.5,
                      GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))) / (12 * 60 * 60)
                    )
                  ELSE 0
                END
              )
              * (CASE WHEN p."parentId" IS NULL THEN 1.15 ELSE 1.0 END)
              * POWER(
                0.85,
                (
                  (CASE WHEN parent."deletedAt" IS NOT NULL THEN 1 ELSE 0 END)
                  +
                  (CASE
                    WHEN root."deletedAt" IS NOT NULL AND (parent."id" IS NULL OR root."id" <> parent."id") THEN 1
                    ELSE 0
                  END)
                )
              )
              AS DOUBLE PRECISION
            ) as "score"
          FROM "Post" p
          JOIN candidates c ON c."id" = p."id"
          LEFT JOIN "User" u ON u."id" = p."userId"
          LEFT JOIN "Post" parent ON parent."id" = p."parentId"
          LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
          LEFT JOIN comment_scores cs ON cs."postId" = p."id"
          CROSS JOIN hashtag_global hg
          LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
        )
        SELECT "id", "createdAt", "score", "userId", "visibility", "parentId", "rootId"
        FROM scored
        WHERE "score" > 0
        ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
        LIMIT 15000
      `);

      const cutoff = new Date(asOf.getTime() - 60 * 60 * 1000);

      // Keep a small rolling window of snapshots so cursor pagination remains stable across refreshes.
      await this.prisma.$transaction(async (tx) => {
        await tx.postPopularScoreSnapshot.deleteMany({ where: { asOf: { lt: cutoff } } });
        // Always delete the exact asOf in case a deploy restarts mid-refresh and reruns.
        await tx.postPopularScoreSnapshot.deleteMany({ where: { asOf } });

        const chunkSize = 1000;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          await tx.postPopularScoreSnapshot.createMany({
            data: chunk.map((r) => ({
              asOf,
              postId: r.id,
              createdAt: r.createdAt,
              score: r.score,
              userId: r.userId,
              visibility: r.visibility,
              parentId: r.parentId ?? null,
              rootId: r.rootId ?? null,
            })),
          });
        }
      });

      const ms = Date.now() - startedAt;
      this.logger.log(`Refreshed trending snapshots: ${rows.length} rows asOf=${asOf.toISOString()} (${ms}ms)`);
    } catch (err) {
      this.logger.warn(`Trending snapshot refresh failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

