-- CreateEnum
CREATE TYPE "CrewMemberRole" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "CrewInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');

-- AlterEnum
ALTER TYPE "MessageConversationType" ADD VALUE 'crew_wall';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'crew_invite_received';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_invite_accepted';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_invite_declined';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_invite_cancelled';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_member_joined';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_member_left';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_member_kicked';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_owner_transferred';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_owner_transfer_vote';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_wall_mention';
ALTER TYPE "NotificationKind" ADD VALUE 'crew_disbanded';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "subjectCrewId" TEXT;

-- CreateTable
CREATE TABLE "Crew" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120),
    "tagline" VARCHAR(160),
    "bio" TEXT,
    "avatarImageUrl" VARCHAR(2000),
    "coverImageUrl" VARCHAR(2000),
    "ownerUserId" TEXT NOT NULL,
    "designatedSuccessorUserId" TEXT,
    "wallConversationId" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewSlugHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slug" VARCHAR(80) NOT NULL,
    "crewId" TEXT NOT NULL,

    CONSTRAINT "CrewSlugHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewMember" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "crewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CrewMemberRole" NOT NULL DEFAULT 'member',

    CONSTRAINT "CrewMember_pkey" PRIMARY KEY ("crewId","userId")
);

-- CreateTable
CREATE TABLE "CrewInvite" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "crewId" TEXT,
    "invitedByUserId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "message" VARCHAR(500),
    "status" "CrewInviteStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "CrewInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewOwnerTransferVote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "crewId" TEXT NOT NULL,
    "proposerUserId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CrewOwnerTransferVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewOwnerTransferBallot" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inFavor" BOOLEAN NOT NULL,

    CONSTRAINT "CrewOwnerTransferBallot_pkey" PRIMARY KEY ("voteId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Crew_slug_key" ON "Crew"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Crew_wallConversationId_key" ON "Crew"("wallConversationId");

-- CreateIndex
CREATE INDEX "Crew_deletedAt_createdAt_idx" ON "Crew"("deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Crew_ownerUserId_idx" ON "Crew"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewSlugHistory_slug_key" ON "CrewSlugHistory"("slug");

-- CreateIndex
CREATE INDEX "CrewSlugHistory_crewId_createdAt_idx" ON "CrewSlugHistory"("crewId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrewMember_userId_key" ON "CrewMember"("userId");

-- CreateIndex
CREATE INDEX "CrewMember_crewId_role_idx" ON "CrewMember"("crewId", "role");

-- CreateIndex
CREATE INDEX "CrewMember_crewId_createdAt_idx" ON "CrewMember"("crewId", "createdAt");

-- CreateIndex
CREATE INDEX "CrewInvite_inviteeUserId_status_createdAt_idx" ON "CrewInvite"("inviteeUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CrewInvite_invitedByUserId_status_createdAt_idx" ON "CrewInvite"("invitedByUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CrewInvite_crewId_status_createdAt_idx" ON "CrewInvite"("crewId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CrewInvite_status_expiresAt_idx" ON "CrewInvite"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CrewOwnerTransferVote_crewId_status_idx" ON "CrewOwnerTransferVote"("crewId", "status");

-- CreateIndex
CREATE INDEX "CrewOwnerTransferVote_status_expiresAt_idx" ON "CrewOwnerTransferVote"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CrewOwnerTransferBallot_userId_updatedAt_idx" ON "CrewOwnerTransferBallot"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_designatedSuccessorUserId_fkey" FOREIGN KEY ("designatedSuccessorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Crew" ADD CONSTRAINT "Crew_wallConversationId_fkey" FOREIGN KEY ("wallConversationId") REFERENCES "MessageConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewSlugHistory" ADD CONSTRAINT "CrewSlugHistory_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewMember" ADD CONSTRAINT "CrewMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewInvite" ADD CONSTRAINT "CrewInvite_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewInvite" ADD CONSTRAINT "CrewInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewInvite" ADD CONSTRAINT "CrewInvite_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewOwnerTransferVote" ADD CONSTRAINT "CrewOwnerTransferVote_crewId_fkey" FOREIGN KEY ("crewId") REFERENCES "Crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewOwnerTransferVote" ADD CONSTRAINT "CrewOwnerTransferVote_proposerUserId_fkey" FOREIGN KEY ("proposerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewOwnerTransferVote" ADD CONSTRAINT "CrewOwnerTransferVote_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewOwnerTransferBallot" ADD CONSTRAINT "CrewOwnerTransferBallot_voteId_fkey" FOREIGN KEY ("voteId") REFERENCES "CrewOwnerTransferVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewOwnerTransferBallot" ADD CONSTRAINT "CrewOwnerTransferBallot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectCrewId_fkey" FOREIGN KEY ("subjectCrewId") REFERENCES "Crew"("id") ON DELETE SET NULL ON UPDATE CASCADE;
