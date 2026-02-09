-- Add actorPostId so notifications can be undone precisely (e.g. delete reply/mention notifications when the source post is deleted).
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "actorPostId" TEXT;

-- Foreign key to Post (best-effort; posts are soft-deleted, but hard deletes should null this).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Notification_actorPostId_fkey'
  ) THEN
    ALTER TABLE "Notification"
      ADD CONSTRAINT "Notification_actorPostId_fkey"
      FOREIGN KEY ("actorPostId") REFERENCES "Post"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Indexes for fast cleanup by post id.
CREATE INDEX IF NOT EXISTS "Notification_actorPostId_idx" ON "Notification"("actorPostId");
CREATE INDEX IF NOT EXISTS "Notification_subjectPostId_idx" ON "Notification"("subjectPostId");

