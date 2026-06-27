-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_deletionScheduledAt_idx" ON "User"("deletionScheduledAt");
