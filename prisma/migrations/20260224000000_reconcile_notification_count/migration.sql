-- One-time reconciliation: recompute undeliveredNotificationCount from actual
-- undelivered notification rows. Corrects any drift caused by the orphan-cleanup
-- cron deleting undelivered notifications without decrementing the counter, or
-- any other historical bug that left the denormalized value out of sync.
-- Clamps to 0 so the value never goes negative.
UPDATE "User" u
SET "undeliveredNotificationCount" = GREATEST(0, (
  SELECT COUNT(*)::INTEGER
  FROM "Notification" n
  WHERE n."recipientUserId" = u.id
    AND n."deliveredAt" IS NULL
));
