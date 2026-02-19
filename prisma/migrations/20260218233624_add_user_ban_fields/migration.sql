-- AlterTable
ALTER TABLE "NotificationPreferences" ALTER COLUMN "lastEmailStreakReminderSentAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "bannedByAdminId" TEXT,
ADD COLUMN     "bannedReason" TEXT;
