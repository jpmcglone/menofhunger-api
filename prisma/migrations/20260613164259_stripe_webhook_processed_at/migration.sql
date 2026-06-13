-- AlterTable
ALTER TABLE "StripeWebhookEvent" ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "StripeWebhookEvent_processedAt_idx" ON "StripeWebhookEvent"("processedAt");
