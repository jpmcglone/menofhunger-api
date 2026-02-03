-- Fix comment notification body to show the commenter's text, not the parent post's.
-- After the comment-subject backfill, subjectPostId points to the comment post; set body from that post.
UPDATE "Notification" n
SET body = (SELECT LEFT(p.body, 150) FROM "Post" p WHERE p.id = n."subjectPostId")
WHERE n.kind = 'comment' AND n."subjectPostId" IS NOT NULL;
