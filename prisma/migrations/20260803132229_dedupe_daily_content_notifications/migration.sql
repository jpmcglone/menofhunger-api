-- Retroactively deduplicate word_of_the_day and quote_of_the_day notifications.
-- For each (recipientUserId, kind) pair we keep the single most-recent row and
-- delete everything older. We also fix the denormalised undeliveredNotificationCount
-- counter: each deleted unread row has already incremented it once, so we decrement
-- it by the number of unread rows removed per user.

WITH to_keep AS (
  -- Latest row per (user, kind) — the one we want to survive.
  SELECT DISTINCT ON ("recipientUserId", kind) id
  FROM "Notification"
  WHERE kind IN ('word_of_the_day', 'quote_of_the_day')
  ORDER BY "recipientUserId", kind, "createdAt" DESC
),
deleted AS (
  DELETE FROM "Notification"
  WHERE kind IN ('word_of_the_day', 'quote_of_the_day')
    AND id NOT IN (SELECT id FROM to_keep)
  RETURNING "recipientUserId", "deliveredAt"
),
unread_deleted AS (
  -- Count unread (deliveredAt IS NULL) rows removed per user — these were counted
  -- in undeliveredNotificationCount and need to be decremented.
  SELECT "recipientUserId", COUNT(*)::int AS cnt
  FROM deleted
  WHERE "deliveredAt" IS NULL
  GROUP BY "recipientUserId"
)
UPDATE "User"
SET "undeliveredNotificationCount" = GREATEST(0, "undeliveredNotificationCount" - unread_deleted.cnt)
FROM unread_deleted
WHERE "User".id = unread_deleted."recipientUserId";
