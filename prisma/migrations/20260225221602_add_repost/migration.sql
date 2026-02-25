-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'repost';

-- AlterEnum
ALTER TYPE "PostKind" ADD VALUE 'repost';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "quotedPostId" TEXT,
ADD COLUMN     "repostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "repostedPostId" TEXT;

-- CreateIndex
CREATE INDEX "Post_repostedPostId_idx" ON "Post"("repostedPostId");

-- CreateIndex
CREATE INDEX "Post_repostedPostId_userId_idx" ON "Post"("repostedPostId", "userId");

-- CreateIndex
CREATE INDEX "Post_quotedPostId_idx" ON "Post"("quotedPostId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_repostedPostId_fkey" FOREIGN KEY ("repostedPostId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_quotedPostId_fkey" FOREIGN KEY ("quotedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
