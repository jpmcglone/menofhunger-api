-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "submitterIp" VARCHAR(64);

-- CreateIndex
CREATE INDEX "Feedback_submitterIp_createdAt_idx" ON "Feedback"("submitterIp", "createdAt");
