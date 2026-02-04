-- Backfill notification titles when missing.
UPDATE "Notification"
SET "title" = CASE
  WHEN "kind" = 'follow' THEN 'followed you'
  WHEN "kind" = 'boost' THEN 'boosted your post'
  WHEN "kind" = 'mention' THEN 'mentioned you'
  WHEN "kind" = 'comment' THEN 'commented on your post'
  ELSE "title"
END
WHERE ("title" IS NULL OR "title" = '')
  AND "kind" IN ('follow', 'boost', 'mention', 'comment');
