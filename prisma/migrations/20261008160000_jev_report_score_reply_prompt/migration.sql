-- CreateEnum
CREATE TYPE "PostReplyPrompt" AS ENUM ('question', 'discussion');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "replyPrompt" "PostReplyPrompt",
ADD COLUMN "replyPromptClassifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Report" ADD COLUMN "jevScoredAt" TIMESTAMP(3),
ADD COLUMN "jevValidScore" DOUBLE PRECISION,
ADD COLUMN "jevHarmScore" DOUBLE PRECISION,
ADD COLUMN "jevCategory" VARCHAR(24),
ADD COLUMN "jevPriority" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Report_status_jevPriority_idx" ON "Report"("status", "jevPriority");
