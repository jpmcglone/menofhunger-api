-- CreateEnum
CREATE TYPE "CrosspostMode" AS ENUM ('link', 'native');

-- Typed X handles were never verified. The column is now written only when OAuth
-- proves the account, so clear every existing value.
UPDATE "User" SET "xUsername" = NULL WHERE "xUsername" IS NOT NULL;

-- AlterTable
ALTER TABLE "PickaxCrosspost" ADD COLUMN "mode" "CrosspostMode" NOT NULL DEFAULT 'native';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "xUrl" TEXT,
ADD COLUMN "xError" TEXT;

-- AlterTable
ALTER TABLE "Article" ADD COLUMN "xUrl" TEXT,
ADD COLUMN "xError" TEXT;

-- CreateTable
CREATE TABLE "XConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "xUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,

    CONSTRAINT "XConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XCrosspost" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "PickaxCrosspostKind" NOT NULL,
    "localId" TEXT NOT NULL,
    "mode" "CrosspostMode" NOT NULL,
    "remoteId" TEXT,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "XCrosspost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "XConnection_userId_key" ON "XConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "XConnection_xUserId_key" ON "XConnection"("xUserId");

-- CreateIndex
CREATE INDEX "XCrosspost_userId_createdAt_idx" ON "XCrosspost"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "XCrosspost_kind_localId_key" ON "XCrosspost"("kind", "localId");

-- AddForeignKey
ALTER TABLE "XConnection" ADD CONSTRAINT "XConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XCrosspost" ADD CONSTRAINT "XCrosspost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
