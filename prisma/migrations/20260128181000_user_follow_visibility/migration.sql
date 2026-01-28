-- CreateEnum
CREATE TYPE "FollowVisibility" AS ENUM ('all', 'verified', 'premium', 'none');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "followVisibility" "FollowVisibility" NOT NULL DEFAULT 'all';

