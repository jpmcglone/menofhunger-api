-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "emailDigestWeekly" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastEmailDigestWeeklySentAt" TIMESTAMP(3);
