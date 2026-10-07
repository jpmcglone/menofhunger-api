-- AlterTable
ALTER TABLE "VerificationRequest" ADD COLUMN "slaAlertedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "VerificationRequest_status_slaAlertedAt_createdAt_idx" ON "VerificationRequest"("status", "slaAlertedAt", "createdAt");
