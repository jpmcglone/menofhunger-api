-- AlterTable: Add rootId column for thread hierarchy
ALTER TABLE "Post" ADD COLUMN "rootId" TEXT;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_rootId_fkey" FOREIGN KEY ("rootId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Post_rootId_idx" ON "Post"("rootId");

-- CreateIndex
CREATE INDEX "Post_rootId_createdAt_idx" ON "Post"("rootId", "createdAt");

-- Backfill rootId for existing posts:
-- For posts with parentId, walk up one level to get the root.
-- This handles depth 1 (direct replies). Deeper threads need recursive fix (handled below).
UPDATE "Post" p
SET "rootId" = COALESCE(
  (SELECT parent."parentId" FROM "Post" parent WHERE parent."id" = p."parentId"),
  p."parentId"
)
WHERE p."parentId" IS NOT NULL AND p."rootId" IS NULL;

-- Recursive fix for deeper threads (depth > 2):
-- Keep updating until no more changes (posts whose rootId still has a parentId).
-- This is a simple iterative approach; for very deep threads, run multiple times.
DO $$
DECLARE
  updated_count INT;
BEGIN
  LOOP
    UPDATE "Post" p
    SET "rootId" = root."rootId"
    FROM "Post" root
    WHERE p."rootId" = root."id"
      AND root."parentId" IS NOT NULL
      AND root."rootId" IS NOT NULL
      AND p."rootId" != root."rootId";
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END $$;
