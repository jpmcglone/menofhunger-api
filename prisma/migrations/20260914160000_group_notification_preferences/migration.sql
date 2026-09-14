CREATE TYPE "GroupNotificationPreference" AS ENUM ('all', 'repliesAndMentions', 'muted');
ALTER TABLE "CommunityGroupMember" ADD COLUMN "notificationPreference" "GroupNotificationPreference" NOT NULL DEFAULT 'all';
