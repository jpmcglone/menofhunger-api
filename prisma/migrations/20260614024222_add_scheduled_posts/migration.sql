-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "scheduledCommunityGroupId" TEXT,
ADD COLUMN     "scheduledError" TEXT,
ADD COLUMN     "scheduledFailedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledPollJson" JSONB,
ADD COLUMN     "scheduledVisibility" "PostVisibility";

-- CreateIndex
CREATE INDEX "Post_scheduledAt_idx" ON "Post"("scheduledAt");
