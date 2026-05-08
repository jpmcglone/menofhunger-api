-- CreateEnum
CREATE TYPE "MarvinCannedReplyReason" AS ENUM ('not_premium', 'ai_not_configured');

-- DropIndex (replacing the (userId, rootPostId) uniqueness with (userId, rootPostId, reason))
DROP INDEX "MarvinNonPremiumThreadReply_userId_rootPostId_key";

-- AlterTable
ALTER TABLE "MarvinNonPremiumThreadReply" ADD COLUMN     "reason" "MarvinCannedReplyReason" NOT NULL DEFAULT 'not_premium';

-- CreateTable
CREATE TABLE "MarvinPrivateCannedReply" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" "MarvinCannedReplyReason" NOT NULL,
    "marvinMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarvinPrivateCannedReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarvinPrivateCannedReply_conversationId_idx" ON "MarvinPrivateCannedReply"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinPrivateCannedReply_userId_conversationId_reason_key" ON "MarvinPrivateCannedReply"("userId", "conversationId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinNonPremiumThreadReply_userId_rootPostId_reason_key" ON "MarvinNonPremiumThreadReply"("userId", "rootPostId", "reason");
