-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "emailInstantHighSignal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastEmailInstantHighSignalSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "NotificationPreferences_lastEmailInstantHighSignalSentAt_idx" ON "NotificationPreferences"("lastEmailInstantHighSignalSentAt");
