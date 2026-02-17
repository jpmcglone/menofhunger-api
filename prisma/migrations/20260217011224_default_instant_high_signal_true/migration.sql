-- Ensure instant high-signal emails are enabled by default.
ALTER TABLE "NotificationPreferences"
ALTER COLUMN "emailInstantHighSignal" SET DEFAULT true;

-- Backfill existing preference rows to enabled.
UPDATE "NotificationPreferences"
SET "emailInstantHighSignal" = true
WHERE "emailInstantHighSignal" = false;
