-- Add nudgedBackAt to notifications (used to persist "you nudged back" state in the feed).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Notification' AND column_name = 'nudgedBackAt'
  ) THEN
    ALTER TABLE "Notification" ADD COLUMN "nudgedBackAt" TIMESTAMP(3);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND c.relname = 'Notification_recipientUserId_nudgedBackAt_idx'
  ) THEN
    CREATE INDEX "Notification_recipientUserId_nudgedBackAt_idx" ON "Notification"("recipientUserId","nudgedBackAt");
  END IF;
END
$$;

