-- Add followed-post notifications kind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'NotificationKind' AND e.enumlabel = 'followed_post'
  ) THEN
    ALTER TYPE "NotificationKind" ADD VALUE 'followed_post';
  END IF;
END
$$;

