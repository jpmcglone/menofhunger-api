-- AlterTable: remove the membershipOverride column added in 20260305110000
ALTER TABLE "User" DROP COLUMN IF EXISTS "membershipOverride";
