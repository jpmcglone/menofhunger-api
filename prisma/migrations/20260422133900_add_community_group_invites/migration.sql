-- CreateEnum
CREATE TYPE "CommunityGroupInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'community_group_invite_received';
ALTER TYPE "NotificationKind" ADD VALUE 'community_group_invite_accepted';
ALTER TYPE "NotificationKind" ADD VALUE 'community_group_invite_declined';
ALTER TYPE "NotificationKind" ADD VALUE 'community_group_invite_cancelled';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectCommunityGroupInviteId" TEXT;

-- CreateTable
CREATE TABLE "CommunityGroupInvite" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "groupId" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "message" VARCHAR(500),
    "status" "CommunityGroupInviteStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "lastDeclinedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "CommunityGroupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityGroupInvite_inviteeUserId_status_createdAt_idx" ON "CommunityGroupInvite"("inviteeUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityGroupInvite_invitedByUserId_status_createdAt_idx" ON "CommunityGroupInvite"("invitedByUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityGroupInvite_groupId_status_createdAt_idx" ON "CommunityGroupInvite"("groupId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CommunityGroupInvite_status_expiresAt_idx" ON "CommunityGroupInvite"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityGroupInvite_groupId_inviteeUserId_key" ON "CommunityGroupInvite"("groupId", "inviteeUserId");

-- AddForeignKey
ALTER TABLE "CommunityGroupInvite" ADD CONSTRAINT "CommunityGroupInvite_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityGroupInvite" ADD CONSTRAINT "CommunityGroupInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityGroupInvite" ADD CONSTRAINT "CommunityGroupInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectCommunityGroupInviteId_fkey" FOREIGN KEY ("subjectCommunityGroupInviteId") REFERENCES "CommunityGroupInvite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
