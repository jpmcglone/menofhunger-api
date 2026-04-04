-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'group_join_request';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectGroupId" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectGroupId_fkey" FOREIGN KEY ("subjectGroupId") REFERENCES "CommunityGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
