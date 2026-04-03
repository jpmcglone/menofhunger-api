-- AlterTable
ALTER TABLE "SubscriptionGrant" ADD COLUMN     "requiresActiveSubscription" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "recruitedById" TEXT,
ADD COLUMN     "referralBonusGrantedAt" TIMESTAMP(3),
ADD COLUMN     "referralCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_recruitedById_idx" ON "User"("recruitedById");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_recruitedById_fkey" FOREIGN KEY ("recruitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
