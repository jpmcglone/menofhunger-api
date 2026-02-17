-- DropIndex
DROP INDEX "NotificationPreferences_lastEmailDigestSentAt_idx";

-- AlterTable
ALTER TABLE "NotificationPreferences" RENAME COLUMN "emailDigestWeekly" TO "emailDigestDaily";
ALTER TABLE "NotificationPreferences" RENAME COLUMN "lastEmailDigestSentAt" TO "lastEmailDigestDailySentAt";

-- CreateIndex
CREATE INDEX "NotificationPreferences_lastEmailDigestDailySentAt_idx" ON "NotificationPreferences"("lastEmailDigestDailySentAt");
