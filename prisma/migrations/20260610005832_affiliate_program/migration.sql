-- CreateEnum
CREATE TYPE "AffiliateEarningType" AS ENUM ('signup', 'verified', 'premium');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "affiliateAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AffiliateEarning" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "affiliateUserId" TEXT NOT NULL,
    "recruitUserId" TEXT NOT NULL,
    "type" "AffiliateEarningType" NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "AffiliateEarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AffiliateEarning_affiliateUserId_settledAt_createdAt_idx" ON "AffiliateEarning"("affiliateUserId", "settledAt", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateEarning_affiliateUserId_createdAt_idx" ON "AffiliateEarning"("affiliateUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AffiliateEarning_settledAt_idx" ON "AffiliateEarning"("settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateEarning_recruitUserId_type_key" ON "AffiliateEarning"("recruitUserId", "type");

-- AddForeignKey
ALTER TABLE "AffiliateEarning" ADD CONSTRAINT "AffiliateEarning_affiliateUserId_fkey" FOREIGN KEY ("affiliateUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateEarning" ADD CONSTRAINT "AffiliateEarning_recruitUserId_fkey" FOREIGN KEY ("recruitUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
