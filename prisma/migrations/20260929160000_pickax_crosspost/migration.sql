-- CreateEnum
CREATE TYPE "PickaxCrosspostKind" AS ENUM ('post', 'article');

-- Typed Pickax handles were never verified. The column is now written only when a Pickax key
-- proves the account, so clear every existing value.
UPDATE "User" SET "pickaxUsername" = NULL WHERE "pickaxUsername" IS NOT NULL;

-- CreateTable
CREATE TABLE "PickaxConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "pickaxUserId" TEXT,
    "username" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,

    CONSTRAINT "PickaxConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickaxCrosspost" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "PickaxCrosspostKind" NOT NULL,
    "localId" TEXT NOT NULL,
    "remoteId" TEXT,
    "contentHash" TEXT,
    "lastError" TEXT,

    CONSTRAINT "PickaxCrosspost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PickaxConnection_userId_key" ON "PickaxConnection"("userId");

-- CreateIndex
CREATE INDEX "PickaxCrosspost_userId_idx" ON "PickaxCrosspost"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PickaxCrosspost_kind_localId_key" ON "PickaxCrosspost"("kind", "localId");

-- AddForeignKey
ALTER TABLE "PickaxConnection" ADD CONSTRAINT "PickaxConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickaxCrosspost" ADD CONSTRAINT "PickaxCrosspost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
