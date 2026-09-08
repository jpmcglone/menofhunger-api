import { Prisma } from "@prisma/client";
import { POSTS_RANKING } from "./posts-ranking.config";

/** One per-post formula for scheduled and immediate refreshes. Candidate selection stays
 * caller-owned; all engagement aggregation is restricted to that bounded candidate set.
 * Author diversity belongs to feed assembly, so the same post scores identically alone
 * or in a batch. Zero scores are returned too, allowing old scores to be cleared.
 */
export function postRankingSql(
  candidateIds: Prisma.Sql,
  asOf: Date,
): Prisma.Sql {
  const minCreatedAt = new Date(
    asOf.getTime() - POSTS_RANKING.popularLookbackDays * 86400000,
  );
  return Prisma.sql`WITH candidates AS (${candidateIds}),
        commenter_latest AS (
          SELECT
            p."parentId" as "postId",
            p."userId" as "userId",
            MAX(p."createdAt") as "latestAt"
          FROM "Post" p
          JOIN candidates c ON c."id" = p."parentId"
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
          JOIN candidates c ON c."id" = r."repostedPostId"
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
          JOIN candidates c ON c."id" = q."quotedPostId"
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
                (p."bookmarkCount"::DOUBLE PRECISION) * ${POSTS_RANKING.popularRepostScoreWeight} * POWER(
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
                COALESCE(frc."count", 0) * ${POSTS_RANKING.popularRepostScoreWeight} * POWER(
                  0.5,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))
                  ) / (12 * 60 * 60)
                )
              )
              +
              (
                -- A flat-repost row is authored feed activity by the reposter.
                CASE WHEN p."kind" = 'repost' THEN 0.5 ELSE 0 END
                * POWER(
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
                COALESCE(qrc."count", 0) * ${POSTS_RANKING.commentScoreWeight} * POWER(
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
                (COALESCE(cs."commentScore", 0)::DOUBLE PRECISION) * ${POSTS_RANKING.commentScoreWeight}
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
                    (CASE WHEN u."premium" THEN ${POSTS_RANKING.pinScorePremium}::double precision WHEN u."verifiedStatus" <> 'none' THEN ${POSTS_RANKING.pinScoreVerified} ELSE ${POSTS_RANKING.pinScoreBase} END)
                    * POWER(
                      0.5,
                      GREATEST(0, EXTRACT(EPOCH FROM (${asOf}::timestamptz - p."createdAt"))) / (12 * 60 * 60)
                    )
                  ELSE 0
                END
              )
              )
              * (CASE WHEN p."parentId" IS NULL THEN ${POSTS_RANKING.popularTopLevelScoreBoost} ELSE 1.0 END)
              * (CASE WHEN p."kind" = 'checkin' THEN 0.85 WHEN p."kind" = 'status' THEN 0.60 ELSE 1.0 END)
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
              * (1 + LEAST(
                ${POSTS_RANKING.popularEngagementRateCap},
                ${POSTS_RANKING.popularEngagementRateWeight} *
                  (p."boostCount" + p."bookmarkCount" + p."commentCount")::double precision /
                  GREATEST(p."weightedViewCount" + ${POSTS_RANKING.popularEngagementRateK}, ${POSTS_RANKING.popularEngagementRateK})
              ))
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
        )
SELECT "id", "score" FROM scored_base`;
}
