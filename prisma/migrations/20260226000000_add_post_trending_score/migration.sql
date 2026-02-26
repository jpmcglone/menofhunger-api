-- Add trendingScore column directly to Post.
-- This replaces the PostPopularScoreSnapshot table: the cron job now UPDATEs this
-- column in place, and the trending feed queries Post directly ordered by trendingScore.

ALTER TABLE "Post" ADD COLUMN "trendingScore" DOUBLE PRECISION;
ALTER TABLE "Post" ADD COLUMN "trendingScoreUpdatedAt" TIMESTAMP(3);

-- Partial index for the trending feed hot path.
-- Only indexes rows that are actually scored, keeping the index compact.
CREATE INDEX "Post_trendingScore_idx"
  ON "Post" ("trendingScore" DESC NULLS LAST, "createdAt" DESC, "id" DESC)
  WHERE "trendingScore" IS NOT NULL AND "trendingScore" > 0 AND "deletedAt" IS NULL;

-- Drop the old snapshot table (all data is transient; nothing needs preserving).
DROP TABLE IF EXISTS "PostPopularScoreSnapshot";
