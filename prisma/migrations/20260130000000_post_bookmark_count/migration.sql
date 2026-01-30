-- Add per-post bookmark counter for fast reads and scoring.
ALTER TABLE "Post"
ADD COLUMN "bookmarkCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing counts.
UPDATE "Post" p
SET "bookmarkCount" = COALESCE(b.cnt, 0)
FROM (
  SELECT "postId", COUNT(*)::int AS cnt
  FROM "Bookmark"
  GROUP BY "postId"
) b
WHERE p."id" = b."postId";

