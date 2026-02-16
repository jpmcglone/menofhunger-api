-- AlterTable
ALTER TABLE "User" ADD COLUMN     "undeliveredNotificationCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing undelivered notifications.
UPDATE "User" u
SET "undeliveredNotificationCount" = (
  SELECT COUNT(*)::INTEGER
  FROM "Notification" n
  WHERE n."recipientUserId" = u.id
    AND n."deliveredAt" IS NULL
);
