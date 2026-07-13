-- Align the denormalized bell counter with the bell-only read contract before
-- getUndeliveredCount starts reading this column directly. Messages and
-- community group posts have dedicated badges and are intentionally excluded.
UPDATE "User" u
SET "undeliveredNotificationCount" = GREATEST(0, (
  SELECT COUNT(*)::INTEGER
  FROM "Notification" n
  WHERE n."recipientUserId" = u.id
    AND n."deliveredAt" IS NULL
    AND n."kind" NOT IN ('message', 'community_group_post')
));
