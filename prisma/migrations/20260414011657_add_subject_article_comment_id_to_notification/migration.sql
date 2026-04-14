-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectArticleCommentId" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectArticleCommentId_fkey" FOREIGN KEY ("subjectArticleCommentId") REFERENCES "ArticleComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
