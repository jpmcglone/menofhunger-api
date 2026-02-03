-- Backfill existing comment notifications so subjectPostId points to the comment (reply) post,
-- not the parent post. New notifications already use the comment's post id; this fixes old ones.
-- For each comment notification we find the comment (Post where parentId = current subjectPostId
-- and userId = actorUserId) whose createdAt is closest to the notification's createdAt.
UPDATE "Notification" n
SET "subjectPostId" = sub."commentId"
FROM (
  SELECT DISTINCT ON (n2.id)
    n2.id AS "notifId",
    p.id AS "commentId"
  FROM "Notification" n2
  JOIN "Post" p
    ON p."parentId" = n2."subjectPostId"
   AND p."userId" = n2."actorUserId"
   AND p."deletedAt" IS NULL
  WHERE n2.kind = 'comment'
   AND n2."subjectPostId" IS NOT NULL
   AND n2."actorUserId" IS NOT NULL
  ORDER BY n2.id, ABS(EXTRACT(EPOCH FROM (n2."createdAt" - p."createdAt")))
) sub
WHERE n.id = sub."notifId"
  AND sub."commentId" IS NOT NULL
  AND sub."commentId" != n."subjectPostId";
