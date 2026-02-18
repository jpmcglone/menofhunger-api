-- Longest streak tracking + streak reminder email prefs.

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "longestStreakDays" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "NotificationPreferences"
ADD COLUMN IF NOT EXISTS "emailStreakReminder" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "lastEmailStreakReminderSentAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "NotificationPreferences_lastEmailStreakReminderSentAt_idx"
ON "NotificationPreferences" ("lastEmailStreakReminderSentAt");

