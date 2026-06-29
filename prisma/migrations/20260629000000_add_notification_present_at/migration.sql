-- Migration: add_notification_present_at
--
-- Adds presentAt to Notification, set at creation time when the recipient was
-- actively present (online + not idle via Redis). Email crons exclude rows
-- where presentAt IS NOT NULL so users are not emailed about notifications
-- they already saw live. Does not affect the in-app bell badge.

ALTER TABLE "Notification" ADD COLUMN "presentAt" TIMESTAMP(3);

CREATE INDEX "Notification_recipientUserId_presentAt_idx"
    ON "Notification"("recipientUserId", "presentAt");
