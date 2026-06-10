-- DropIndex
DROP INDEX "CommunityGroup_description_trgm_idx";

-- DropIndex
DROP INDEX "CommunityGroup_name_trgm_idx";

-- DropIndex
DROP INDEX "CommunityGroup_slug_trgm_idx";

-- DropIndex
DROP INDEX "User_statusExpiresAt_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "openToCrewAt" TIMESTAMP(3);
