-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'followed_article';

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "trendingScore" DOUBLE PRECISION,
ADD COLUMN     "trendingScoreUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectArticleId" TEXT;

-- CreateIndex
CREATE INDEX "Article_trendingScore_publishedAt_idx" ON "Article"("trendingScore" DESC, "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_subjectArticleId_idx" ON "Notification"("subjectArticleId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectArticleId_fkey" FOREIGN KEY ("subjectArticleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;
