-- DropIndex
DROP INDEX "NotificationPreferences_lastEmailDigestDailySentAt_idx";

-- AlterTable
ALTER TABLE "NotificationPreferences" DROP COLUMN "emailDigestDaily",
DROP COLUMN "lastEmailDigestDailySentAt";
