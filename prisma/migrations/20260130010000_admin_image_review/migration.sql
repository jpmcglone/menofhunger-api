-- Add PostMedia tombstones (admin hard delete support)
ALTER TABLE "PostMedia"
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedByAdminId" TEXT,
ADD COLUMN     "deletedReason" TEXT;

-- Create MediaAsset index table (all R2 objects, including orphans)
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "r2Key" TEXT NOT NULL,
    "r2LastModified" TIMESTAMP(3),
    "bytes" INTEGER,
    "contentType" TEXT,
    "kind" "PostMediaKind",
    "width" INTEGER,
    "height" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "deletedByAdminId" TEXT,
    "deleteReason" TEXT,
    "r2DeletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- Uniques
CREATE UNIQUE INDEX "MediaAsset_r2Key_key" ON "MediaAsset"("r2Key");

-- Indexes (newest-first ordering + admin filtering)
CREATE INDEX "MediaAsset_r2LastModified_id_idx" ON "MediaAsset"("r2LastModified" DESC, "id" DESC);
CREATE INDEX "MediaAsset_deletedAt_idx" ON "MediaAsset"("deletedAt");
CREATE INDEX "PostMedia_deletedAt_idx" ON "PostMedia"("deletedAt");

-- Foreign keys (admin audit)
ALTER TABLE "PostMedia"
ADD CONSTRAINT "PostMedia_deletedByAdminId_fkey" FOREIGN KEY ("deletedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MediaAsset"
ADD CONSTRAINT "MediaAsset_deletedByAdminId_fkey" FOREIGN KEY ("deletedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

