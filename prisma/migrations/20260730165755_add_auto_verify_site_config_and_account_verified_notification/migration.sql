-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'account_verified';

-- AlterTable
ALTER TABLE "SiteConfig" ADD COLUMN     "autoVerifyNewUsers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoVerifyRecruiterId" TEXT;
