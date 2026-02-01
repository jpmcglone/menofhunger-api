-- AlterEnum: add 'video' to PostMediaKind
ALTER TYPE "PostMediaKind" ADD VALUE 'video';

-- PostMedia: add thumbnailR2Key and durationSeconds
ALTER TABLE "PostMedia" ADD COLUMN "thumbnailR2Key" TEXT;
ALTER TABLE "PostMedia" ADD COLUMN "durationSeconds" INTEGER;

-- CreateTable: MediaContentHash for dedupe by content hash
CREATE TABLE "MediaContentHash" (
    "contentHash" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "kind" "PostMediaKind" NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaContentHash_pkey" PRIMARY KEY ("contentHash")
);

CREATE UNIQUE INDEX "MediaContentHash_contentHash_key" ON "MediaContentHash"("contentHash");
