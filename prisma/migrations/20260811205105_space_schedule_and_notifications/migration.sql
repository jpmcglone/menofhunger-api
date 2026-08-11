-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'space_reminder_day';
ALTER TYPE "NotificationKind" ADD VALUE 'space_reminder_soon';
ALTER TYPE "NotificationKind" ADD VALUE 'space_live';
ALTER TYPE "NotificationKind" ADD VALUE 'space_schedule_cancelled';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectSpaceId" TEXT;

-- AlterTable
ALTER TABLE "Space" ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SpaceScheduleSubscriber" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "SpaceScheduleSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpaceScheduleSubscriber_userId_createdAt_idx" ON "SpaceScheduleSubscriber"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SpaceScheduleSubscriber_spaceId_createdAt_idx" ON "SpaceScheduleSubscriber"("spaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpaceScheduleSubscriber_spaceId_userId_key" ON "SpaceScheduleSubscriber"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "Notification_subjectSpaceId_idx" ON "Notification"("subjectSpaceId");

-- CreateIndex
CREATE INDEX "Space_scheduledAt_idx" ON "Space"("scheduledAt");

-- AddForeignKey
ALTER TABLE "SpaceScheduleSubscriber" ADD CONSTRAINT "SpaceScheduleSubscriber_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceScheduleSubscriber" ADD CONSTRAINT "SpaceScheduleSubscriber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectSpaceId_fkey" FOREIGN KEY ("subjectSpaceId") REFERENCES "Space"("id") ON DELETE SET NULL ON UPDATE CASCADE;

