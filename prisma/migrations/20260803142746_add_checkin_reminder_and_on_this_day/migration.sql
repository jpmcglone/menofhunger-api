-- Add checkin_reminder and on_this_day notification kinds.
ALTER TYPE "NotificationKind" ADD VALUE 'checkin_reminder';
ALTER TYPE "NotificationKind" ADD VALUE 'on_this_day';

-- Add pushCheckinReminder preference (default true — matches existing push pref pattern).
ALTER TABLE "NotificationPreferences" ADD COLUMN "pushCheckinReminder" BOOLEAN NOT NULL DEFAULT true;

-- Add fan-out gating columns to DailyContentSnapshot.
ALTER TABLE "DailyContentSnapshot"
  ADD COLUMN "checkinReminderNotifiedAt"   TIMESTAMP(3),
  ADD COLUMN "checkinReminderFanoutCursor" TEXT,
  ADD COLUMN "onThisDayNotifiedAt"         TIMESTAMP(3),
  ADD COLUMN "onThisDayFanoutCursor"       TEXT;
