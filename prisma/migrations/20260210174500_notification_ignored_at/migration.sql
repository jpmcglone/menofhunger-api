-- Add ignoredAt to notifications (used for "Ignore" on nudges).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'Notification' AND column_name = 'ignoredAt'
  ) THEN
    ALTER TABLE "Notification" ADD COLUMN "ignoredAt" TIMESTAMP(3);
  END IF;
END
$$;

-- Index for common recipient + ignoredAt queries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND c.relname = 'Notification_recipientUserId_ignoredAt_idx'
  ) THEN
    CREATE INDEX "Notification_recipientUserId_ignoredAt_idx" ON "Notification"("recipientUserId","ignoredAt");
  END IF;
END
$$;

