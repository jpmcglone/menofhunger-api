-- Last Pickax rejection per post/article so the author sees it where they published,
-- not only in Settings.
ALTER TABLE "Post" ADD COLUMN "pickaxError" TEXT;
ALTER TABLE "Article" ADD COLUMN "pickaxError" TEXT;

UPDATE "Post" p
SET "pickaxError" = c."lastError"
FROM "PickaxCrosspost" c
WHERE c."kind" = 'post' AND c."localId" = p."id" AND c."lastError" IS NOT NULL;

UPDATE "Article" a
SET "pickaxError" = c."lastError"
FROM "PickaxCrosspost" c
WHERE c."kind" = 'article' AND c."localId" = a."id" AND c."lastError" IS NOT NULL;
