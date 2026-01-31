-- DropForeignKey
ALTER TABLE "Bookmark" DROP CONSTRAINT "Bookmark_collectionId_fkey";

-- DropIndex
DROP INDEX "MediaAsset_r2LastModified_id_idx";

-- AlterTable
ALTER TABLE "BookmarkCollection" ADD COLUMN "slug" TEXT;

-- CreateTable
CREATE TABLE "BookmarkCollectionItem" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bookmarkId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,

    CONSTRAINT "BookmarkCollectionItem_pkey" PRIMARY KEY ("bookmarkId","collectionId")
);

-- CreateIndex
CREATE INDEX "BookmarkCollectionItem_collectionId_createdAt_idx" ON "BookmarkCollectionItem"("collectionId", "createdAt");

-- CreateIndex
CREATE INDEX "BookmarkCollectionItem_bookmarkId_createdAt_idx" ON "BookmarkCollectionItem"("bookmarkId", "createdAt");

-- Backfill join rows from the old single-folder column.
INSERT INTO "BookmarkCollectionItem" ("bookmarkId", "collectionId")
SELECT b."id", b."collectionId"
FROM "Bookmark" b
WHERE b."collectionId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- DropIndex
DROP INDEX "Bookmark_collectionId_createdAt_idx";

-- AlterTable
ALTER TABLE "Bookmark" DROP COLUMN "collectionId";

-- Backfill slugs for existing collections (deterministic from name).
UPDATE "BookmarkCollection"
SET "slug" = regexp_replace(
  regexp_replace(lower(trim("name")), '[^a-z0-9]+', '-', 'g'),
  '(^-+|-+$)',
  '',
  'g'
)
WHERE "slug" IS NULL;

-- Ensure slug is present (reject pathological names like '!!!').
ALTER TABLE "BookmarkCollection" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BookmarkCollection_userId_slug_key" ON "BookmarkCollection"("userId", "slug");

-- CreateIndex
CREATE INDEX "MediaAsset_r2LastModified_id_idx" ON "MediaAsset"("r2LastModified", "id");

-- AddForeignKey
ALTER TABLE "BookmarkCollectionItem" ADD CONSTRAINT "BookmarkCollectionItem_bookmarkId_fkey" FOREIGN KEY ("bookmarkId") REFERENCES "Bookmark"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookmarkCollectionItem" ADD CONSTRAINT "BookmarkCollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "BookmarkCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
