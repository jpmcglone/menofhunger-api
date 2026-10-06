-- CreateEnum
CREATE TYPE "GroupChannelPrivacy" AS ENUM ('normal', 'private');

-- CreateEnum
CREATE TYPE "GroupChannelDefault" AS ENUM ('announcements', 'general', 'random');

-- CreateEnum
CREATE TYPE "GroupChannelPreference" AS ENUM ('all', 'mentions', 'off');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportTargetType" ADD VALUE 'message';
ALTER TYPE "ReportTargetType" ADD VALUE 'article';

-- AlterEnum
ALTER TYPE "MessageConversationType" ADD VALUE 'channel';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "channelRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "channelSequence" INTEGER,
ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "threadRootId" TEXT;

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "evidenceText" TEXT,
ADD COLUMN     "subjectArticleId" TEXT,
ADD COLUMN     "subjectMessageId" TEXT;

-- CreateTable
CREATE TABLE "GroupChannel" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "topic" VARCHAR(500) NOT NULL DEFAULT '',
    "privacy" "GroupChannelPrivacy" NOT NULL DEFAULT 'normal',
    "defaultPurpose" "GroupChannelDefault",
    "archivedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupChannelAccess" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupChannelAccess_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateTable
CREATE TABLE "GroupChannelViewerState" (
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readThrough" INTEGER NOT NULL DEFAULT 0,
    "preference" "GroupChannelPreference" NOT NULL DEFAULT 'mentions',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupChannelViewerState_pkey" PRIMARY KEY ("channelId","userId")
);

-- CreateTable
CREATE TABLE "GroupChannelThreadState" (
    "rootMessageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "following" BOOLEAN NOT NULL DEFAULT true,
    "unfollowed" BOOLEAN NOT NULL DEFAULT false,
    "readThrough" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GroupChannelThreadState_pkey" PRIMARY KEY ("rootMessageId","userId")
);

-- CreateTable
CREATE TABLE "GroupChannelAttention" (
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mentioned" BOOLEAN NOT NULL DEFAULT false,
    "followedReply" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupChannelAttention_pkey" PRIMARY KEY ("messageId","userId")
);

-- CreateTable
CREATE TABLE "GroupChannelPin" (
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupChannelPin_pkey" PRIMARY KEY ("channelId","messageId")
);

-- CreateTable
CREATE TABLE "GroupChannelUpload" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "kind" "PostMediaKind" NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DOUBLE PRECISION,
    "committedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupChannelUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupChannelDelivery" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" VARCHAR(16) NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupChannelDelivery_pkey" PRIMARY KEY ("messageId","userId","reason")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupChannel_conversationId_key" ON "GroupChannel"("conversationId");

-- CreateIndex
CREATE INDEX "GroupChannel_groupId_archivedAt_idx" ON "GroupChannel"("groupId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroupChannel_groupId_name_key" ON "GroupChannel"("groupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GroupChannel_groupId_defaultPurpose_key" ON "GroupChannel"("groupId", "defaultPurpose");

-- CreateIndex
CREATE INDEX "GroupChannelAccess_userId_idx" ON "GroupChannelAccess"("userId");

-- CreateIndex
CREATE INDEX "GroupChannelThreadState_userId_following_idx" ON "GroupChannelThreadState"("userId", "following");

-- CreateIndex
CREATE INDEX "GroupChannelAttention_userId_readAt_channelId_idx" ON "GroupChannelAttention"("userId", "readAt", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupChannelUpload_sourceKey_key" ON "GroupChannelUpload"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "GroupChannelUpload_r2Key_key" ON "GroupChannelUpload"("r2Key");

-- CreateIndex
CREATE INDEX "GroupChannelUpload_userId_expiresAt_idx" ON "GroupChannelUpload"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_threadRootId_channelSequence_idx" ON "Message"("conversationId", "threadRootId", "channelSequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_channelSequence_key" ON "Message"("conversationId", "channelSequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_senderId_clientRequestId_key" ON "Message"("conversationId", "senderId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadRootId_fkey" FOREIGN KEY ("threadRootId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_subjectMessageId_fkey" FOREIGN KEY ("subjectMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_subjectArticleId_fkey" FOREIGN KEY ("subjectArticleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannel" ADD CONSTRAINT "GroupChannel_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannel" ADD CONSTRAINT "GroupChannel_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "MessageConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelAccess" ADD CONSTRAINT "GroupChannelAccess_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "GroupChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelAccess" ADD CONSTRAINT "GroupChannelAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelViewerState" ADD CONSTRAINT "GroupChannelViewerState_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "GroupChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelViewerState" ADD CONSTRAINT "GroupChannelViewerState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelThreadState" ADD CONSTRAINT "GroupChannelThreadState_rootMessageId_fkey" FOREIGN KEY ("rootMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelThreadState" ADD CONSTRAINT "GroupChannelThreadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelAttention" ADD CONSTRAINT "GroupChannelAttention_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "GroupChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelAttention" ADD CONSTRAINT "GroupChannelAttention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelAttention" ADD CONSTRAINT "GroupChannelAttention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelPin" ADD CONSTRAINT "GroupChannelPin_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "GroupChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelPin" ADD CONSTRAINT "GroupChannelPin_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelUpload" ADD CONSTRAINT "GroupChannelUpload_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "GroupChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelUpload" ADD CONSTRAINT "GroupChannelUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelDelivery" ADD CONSTRAINT "GroupChannelDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupChannelDelivery" ADD CONSTRAINT "GroupChannelDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

