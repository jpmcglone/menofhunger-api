-- Add quoteCount column: denormalized count of quote reposts (posts whose quotedPostId points here).
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "quoteCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: count existing quotes per post.
UPDATE "Post" target
SET "quoteCount" = (
  SELECT COUNT(*)::int
  FROM "Post" q
  WHERE q."quotedPostId" = target.id
    AND q."deletedAt" IS NULL
);
