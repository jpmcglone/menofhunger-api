-- Public Pickax links, denormalized onto the row so feeds and articles can link out
-- without a per-row lookup into PickaxCrosspost.
ALTER TABLE "Post" ADD COLUMN "pickaxUrl" TEXT;
ALTER TABLE "Article" ADD COLUMN "pickaxUrl" TEXT;

-- Backfill from cross-posts that already succeeded.
UPDATE "Post" p
SET "pickaxUrl" = 'https://pickax.com/post/' || c."remoteId"
FROM "PickaxCrosspost" c
WHERE c."kind" = 'post' AND c."localId" = p."id" AND c."remoteId" IS NOT NULL;

UPDATE "Article" a
SET "pickaxUrl" = 'https://pickax.com/articles/' || c."remoteId"
FROM "PickaxCrosspost" c
WHERE c."kind" = 'article' AND c."localId" = a."id" AND c."remoteId" IS NOT NULL;
