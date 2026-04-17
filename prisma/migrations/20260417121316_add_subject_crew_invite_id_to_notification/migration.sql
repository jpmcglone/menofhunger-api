-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectCrewInviteId" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectCrewInviteId_fkey" FOREIGN KEY ("subjectCrewInviteId") REFERENCES "CrewInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
