-- Product: reply notifications for follows are ON by default.
-- Re-assert the column default and turn every existing follow row back on.
ALTER TABLE "Follow" ALTER COLUMN "postNotificationsEnabled" SET DEFAULT true;

UPDATE "Follow"
SET "postNotificationsEnabled" = true
WHERE "postNotificationsEnabled" = false;
