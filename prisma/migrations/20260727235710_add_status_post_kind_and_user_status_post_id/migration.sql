-- AlterEnum
ALTER TYPE "PostKind" ADD VALUE 'status';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "statusPostId" TEXT;
