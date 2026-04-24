-- AlterEnum: add new NotificationKind values
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'message';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'community_group_member_joined';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'community_group_join_approved';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'community_group_join_rejected';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'community_group_member_removed';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'community_group_disbanded';

-- AlterTable: add subjectConversationId to Notification
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "subjectConversationId" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectConversationId_fkey"
  FOREIGN KEY ("subjectConversationId") REFERENCES "MessageConversation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: add pushGroupActivity to NotificationPreferences
ALTER TABLE "NotificationPreferences" ADD COLUMN IF NOT EXISTS "pushGroupActivity" BOOLEAN NOT NULL DEFAULT true;
