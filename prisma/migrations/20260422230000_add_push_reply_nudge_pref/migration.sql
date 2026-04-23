-- Add the per-user push preference for the 24h reply-nudge cron.
-- Default true: opt-out, not opt-in. The nudge is at most one push ever per reply notification.
ALTER TABLE "NotificationPreferences"
ADD COLUMN "pushReplyNudge" BOOLEAN NOT NULL DEFAULT true;
