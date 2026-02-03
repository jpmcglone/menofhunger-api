-- Backfill body for existing comment/mention notifications using the subject post's body (first 150 chars).
-- New notifications already get a snippet at creation time; this fixes ones created before that change.
UPDATE "Notification" n
SET body = LEFT(p.body, 150)
FROM "Post" p
WHERE n."subjectPostId" = p.id
  AND n.kind IN ('comment', 'mention')
  AND (n.body IS NULL OR n.body = '');
