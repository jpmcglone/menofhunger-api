-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'poll_results_ready';

-- AlterTable
ALTER TABLE "PostPoll" ADD COLUMN     "resultsNotifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PostPoll_resultsNotifiedAt_idx" ON "PostPoll"("resultsNotifiedAt");
