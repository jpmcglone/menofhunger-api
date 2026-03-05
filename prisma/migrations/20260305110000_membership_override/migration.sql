-- AlterTable: add permanent membership override to User (null = no override)
ALTER TABLE "User" ADD COLUMN "membershipOverride" "SubscriptionGrantTier";
