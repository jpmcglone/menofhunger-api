-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Hashtag" (
    "tag" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("tag")
);

-- CreateIndex
CREATE INDEX "Hashtag_usageCount_idx" ON "Hashtag"("usageCount");

-- CreateIndex
CREATE INDEX "Hashtag_updatedAt_idx" ON "Hashtag"("updatedAt");

-- CreateIndex
CREATE INDEX "Post_hashtags_idx" ON "Post" USING GIN ("hashtags");
