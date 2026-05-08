-- CreateEnum
CREATE TYPE "MarvinSource" AS ENUM ('public_thread', 'private_session');

-- CreateEnum
CREATE TYPE "MarvinMode" AS ENUM ('fast', 'regular', 'smart');

-- NOTE: prisma migrate diff also suggested dropping pre-existing trigram/statusExpiresAt
-- indexes that exist in the DB but not declared in the Prisma schema (custom SQL indexes
-- created by earlier migrations, e.g. pg_trgm GIN). Those drops were intentionally removed
-- so Marv's migration is purely additive. Do not re-add them here.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "botType" TEXT,
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MarvinCreditBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credits" DOUBLE PRECISION NOT NULL,
    "lastRefilledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinCreditBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinUsageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "MarvinSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "rootPostId" TEXT,
    "requestedMode" "MarvinMode" NOT NULL,
    "effectiveMode" "MarvinMode" NOT NULL,
    "creditsSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cachedInputTokens" INTEGER,
    "modelUsed" TEXT,
    "estimatedCostUsd" DECIMAL(10,6),
    "responseId" TEXT,
    "routingReason" TEXT,
    "errorCode" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarvinUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinIdempotencyKey" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarvinIdempotencyKey_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "MarvinThreadSummary" (
    "id" TEXT NOT NULL,
    "rootPostId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "lastMessageIdIncluded" TEXT,
    "tokensApprox" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinThreadSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinPrivateSessionState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "summary" TEXT,
    "lastResponseId" TEXT,
    "lastMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinPrivateSessionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserContextCard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardText" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserContextCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinNonPremiumThreadReply" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rootPostId" TEXT NOT NULL,
    "marvinPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarvinNonPremiumThreadReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinUserSettings" (
    "userId" TEXT NOT NULL,
    "preferredMode" "MarvinMode" NOT NULL DEFAULT 'regular',
    "disabledByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinUserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "MarvinGlobalSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fastCost" DOUBLE PRECISION,
    "regularCost" DOUBLE PRECISION,
    "smartCost" DOUBLE PRECISION,
    "fastModel" TEXT,
    "regularModel" TEXT,
    "smartModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinGlobalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarvinCostRollup" (
    "id" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "userId" TEXT,
    "mode" "MarvinMode",
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "totalCreditsSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinCostRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarvinCreditBalance_userId_key" ON "MarvinCreditBalance"("userId");

-- CreateIndex
CREATE INDEX "MarvinUsageEvent_userId_createdAt_idx" ON "MarvinUsageEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MarvinUsageEvent_source_createdAt_idx" ON "MarvinUsageEvent"("source", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MarvinUsageEvent_effectiveMode_createdAt_idx" ON "MarvinUsageEvent"("effectiveMode", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MarvinIdempotencyKey_createdAt_idx" ON "MarvinIdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinThreadSummary_rootPostId_key" ON "MarvinThreadSummary"("rootPostId");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinPrivateSessionState_conversationId_key" ON "MarvinPrivateSessionState"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "UserContextCard_userId_key" ON "UserContextCard"("userId");

-- CreateIndex
CREATE INDEX "MarvinNonPremiumThreadReply_rootPostId_idx" ON "MarvinNonPremiumThreadReply"("rootPostId");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinNonPremiumThreadReply_userId_rootPostId_key" ON "MarvinNonPremiumThreadReply"("userId", "rootPostId");

-- CreateIndex
CREATE INDEX "MarvinCostRollup_dayKey_idx" ON "MarvinCostRollup"("dayKey");

-- CreateIndex
CREATE INDEX "MarvinCostRollup_userId_dayKey_idx" ON "MarvinCostRollup"("userId", "dayKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarvinCostRollup_dayKey_userId_mode_key" ON "MarvinCostRollup"("dayKey", "userId", "mode");

-- AddForeignKey
ALTER TABLE "MarvinCreditBalance" ADD CONSTRAINT "MarvinCreditBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarvinUsageEvent" ADD CONSTRAINT "MarvinUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserContextCard" ADD CONSTRAINT "UserContextCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarvinUserSettings" ADD CONSTRAINT "MarvinUserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
