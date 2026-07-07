-- Change the column default from false → true so all new follows have the bell ON.
ALTER TABLE "Follow" ALTER COLUMN "postNotificationsEnabled" SET DEFAULT true;

-- Backfill every existing follow so the bell is ON for everyone's current follows.
UPDATE "Follow" SET "postNotificationsEnabled" = true WHERE "postNotificationsEnabled" = false;
