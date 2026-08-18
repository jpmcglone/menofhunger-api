-- Unique people stay on viewerCount / viewCount.
-- totalViewCount is accepted impressions, seeded from today's unique counts.

ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "totalViewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "totalViewCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PostView" ADD COLUMN IF NOT EXISTS "impressionCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "PostView" ADD COLUMN IF NOT EXISTS "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "PostAnonView" ADD COLUMN IF NOT EXISTS "impressionCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "PostAnonView" ADD COLUMN IF NOT EXISTS "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ArticleView" ADD COLUMN IF NOT EXISTS "impressionCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ArticleView" ADD COLUMN IF NOT EXISTS "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ArticleAnonView" ADD COLUMN IF NOT EXISTS "impressionCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ArticleAnonView" ADD COLUMN IF NOT EXISTS "lastImpressionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Post" SET "totalViewCount" = "viewerCount" WHERE "totalViewCount" = 0 AND "viewerCount" > 0;
UPDATE "Article" SET "totalViewCount" = "viewCount" WHERE "totalViewCount" = 0 AND "viewCount" > 0;

UPDATE "PostView" SET "lastImpressionAt" = "lastSeenAt";
UPDATE "PostAnonView" SET "lastImpressionAt" = "lastViewedAt";
UPDATE "ArticleView" SET "lastImpressionAt" = "createdAt";
UPDATE "ArticleAnonView" SET "lastImpressionAt" = "lastViewedAt";
