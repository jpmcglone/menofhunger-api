-- Preserve the old bell setting: false disabled replies, not posts/articles.
CREATE TYPE "FollowNotificationPreference" AS ENUM ('all', 'posts', 'off');
ALTER TABLE "Follow" ADD COLUMN "notificationPreference" "FollowNotificationPreference" NOT NULL DEFAULT 'all';
UPDATE "Follow" SET "notificationPreference" = 'posts' WHERE "postNotificationsEnabled" = false;
