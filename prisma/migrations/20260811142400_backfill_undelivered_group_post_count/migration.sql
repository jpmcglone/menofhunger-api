-- Backfill denormalized Groups badge count from undelivered community_group_post rows.
UPDATE "User" u
SET "undeliveredGroupPostCount" = (
  SELECT COUNT(*)::INTEGER
  FROM "Notification" n
  WHERE n."recipientUserId" = u.id
    AND n.kind = 'community_group_post'
    AND n."deliveredAt" IS NULL
);
