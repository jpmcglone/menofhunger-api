-- CreateEnum
CREATE TYPE "SubscriptionGrantTier" AS ENUM ('premium', 'premiumPlus');

-- CreateEnum
CREATE TYPE "SubscriptionGrantSource" AS ENUM ('admin', 'referral');

-- CreateTable
CREATE TABLE "SubscriptionGrant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "tier" "SubscriptionGrantTier" NOT NULL,
    "source" "SubscriptionGrantSource" NOT NULL,
    "months" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "grantedByAdminId" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionGrant_userId_endsAt_idx" ON "SubscriptionGrant"("userId", "endsAt");

-- CreateIndex
CREATE INDEX "SubscriptionGrant_userId_revokedAt_endsAt_idx" ON "SubscriptionGrant"("userId", "revokedAt", "endsAt");

-- CreateIndex
CREATE INDEX "SubscriptionGrant_createdAt_idx" ON "SubscriptionGrant"("createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionGrant" ADD CONSTRAINT "SubscriptionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionGrant" ADD CONSTRAINT "SubscriptionGrant_grantedByAdminId_fkey" FOREIGN KEY ("grantedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
