import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from './posts.service';
import { JobsService } from '../jobs/jobs.service';
import { JOBS } from '../jobs/jobs.constants';
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
      const rows = await this.prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        WITH
        commenter_latest AS (
          SELECT
            p."parentId" as "postId",
            p."userId" as "userId",
            MAX(p."createdAt") as "latestAt"
          FROM "Post" p
          WHERE
            p."parentId" IS NOT NULL
            AND p."deletedAt" IS NULL
            AND p."createdAt" >= ${minCreatedAt}
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
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - cl."latestAt"))
                  ) / (12 * 60 * 60)
                )
              ) AS DOUBLE PRECISION
            ) as "commentScore"
          FROM commenter_latest cl
          GROUP BY cl."postId"
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
                AND p."kind"::text <> 'repost'
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
                AND p."kind"::text <> 'repost'
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
                AND p."kind"::text <> 'repost'
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
                AND p."kind"::text <> 'repost'
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
                AND p."kind"::text <> 'repost'
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
                AND p."kind"::text <> 'repost'
              ORDER BY p."createdAt" DESC, p."id" DESC
              LIMIT 4000
            )
          ) u
          JOIN "Post" _nog ON _nog."id" = u."id"
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
        flat_repost_counts AS (
          -- Flat reposts (kind='repost'): reshared without added commentary.
          -- Weighted like bookmarks (lower social signal than a reply/quote).
          SELECT r."repostedPostId" as "postId", COUNT(*)::DOUBLE PRECISION as "count"
          FROM "Post" r
          WHERE r."repostedPostId" IS NOT NULL
            AND r."deletedAt" IS NULL
            AND r."createdAt" >= ${minCreatedAt}
          GROUP BY r."repostedPostId"
        ),
        quote_repost_counts AS (
          -- Quote reposts: regular posts that embed another post URL.
          -- Weighted like replies (meaningful engagement / commentary).
          SELECT q."quotedPostId" as "postId", COUNT(*)::DOUBLE PRECISION as "count"
          FROM "Post" q
          WHERE q."quotedPostId" IS NOT NULL
            AND q."deletedAt" IS NULL
            AND q."createdAt" >= ${minCreatedAt}
          GROUP BY q."quotedPostId"
        ),
        scored_base AS (
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
                -- Flat reposts (no commentary): same weight as bookmarks.
                COALESCE(frc."count", 0) * 0.5 * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (12 * 60 * 60)
                )
              )
              +
              (
                -- Quote reposts (with commentary): weighted like replies (0.8), same 72h post-age decay
                -- so their value degrades at the same rate as reply-based engagement.
                COALESCE(qrc."count", 0) * 0.8 * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (72 * 60 * 60)
                )
              )
              +
              (
                -- Replies: decayed by both comment recency AND post age (72h half-life for post age).
                -- Without the post-age factor, old posts with recent comments rank disproportionately high.
                -- Weight 0.8: meaningfully above bookmarks/flat-reposts, just below boosts.
                (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * 0.8
                * POWER(
                  0.5,
                  GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))) / (72 * 60 * 60)
                )
              )
              +
              (
                -- Poll votes: direct engagement signal, decayed by post age like bookmarks.
                COALESCE(poll."totalVoteCount", 0)::DOUBLE PRECISION * 0.3 * POWER(
                  0.5,
                  GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))) / (12 * 60 * 60)
                )
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
                      GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))) / (12 * 60 * 60)
                    )
                  ELSE 0
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
              * (CASE WHEN p."kind" = 'checkin' THEN 0.85 ELSE 1.0 END)
              * (
                CASE
                  WHEN u."verifiedStatus" = 'none' AND u."createdAt" >= (${asOf}::timestamptz - INTERVAL '7 days') THEN 0.85
                  ELSE 1.0
                END
              )
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
              +
              (
                -- Group wall trending persists scores only when final score > 0; a tiny floor keeps
                -- zero-engagement group roots rankable without affecting global feeds (they filter communityGroupId IS NULL).
                CASE
                  WHEN p."communityGroupId" IS NOT NULL AND p."parentId" IS NULL THEN 1e-10
                  ELSE 0
                END
              )
              AS DOUBLE PRECISION
            ) as "score"
          FROM "Post" p
          JOIN candidates c ON c."id" = p."id"
          LEFT JOIN "User" u ON u."id" = p."userId"
          LEFT JOIN "Post" parent ON parent."id" = p."parentId"
          LEFT JOIN "Post" root ON root."id" = COALESCE(p."rootId", p."id")
          LEFT JOIN comment_scores cs ON cs."postId" = p."id"
          LEFT JOIN "PostPoll" poll ON poll."postId" = p."id"
          LEFT JOIN flat_repost_counts frc ON frc."postId" = p."id"
          LEFT JOIN quote_repost_counts qrc ON qrc."postId" = p."id"
          CROSS JOIN hashtag_global hg
          LEFT JOIN post_hashtag_scores hs ON hs."postId" = p."id"
        ),
        scored AS (
          SELECT
            sb."id",
            sb."createdAt",
            CAST(
              sb."score"
              * POWER(
                0.90,
                GREATEST(
                  0,
                  (ROW_NUMBER() OVER (PARTITION BY sb."userId" ORDER BY sb."score" DESC, sb."createdAt" DESC, sb."id" DESC) - 1)
                )
              )
              AS DOUBLE PRECISION
            ) as "score"
          FROM scored_base sb
        )
        SELECT "id", "score"
        FROM scored
        WHERE "score" > 0
        ORDER BY "score" DESC, "createdAt" DESC, "id" DESC
      `);

      // Bulk-update Post.trendingScore in chunks using a VALUES table join for efficiency.
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = chunk.map((r) => Prisma.sql`(${r.id}, ${r.score}::double precision)`);
        await this.prisma.$executeRaw`
          UPDATE "Post" AS p
          SET "trendingScore" = v.score,
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

