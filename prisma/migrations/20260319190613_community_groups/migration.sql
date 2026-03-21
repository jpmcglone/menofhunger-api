-- CreateEnum
CREATE TYPE "CommunityGroupJoinPolicy" AS ENUM ('open', 'approval');

-- CreateEnum
CREATE TYPE "CommunityGroupMemberRole" AS ENUM ('owner', 'moderator', 'member');

-- CreateEnum
CREATE TYPE "CommunityGroupMemberStatus" AS ENUM ('active', 'pending');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "communityGroupId" TEXT;

-- CreateTable
CREATE TABLE "CommunityGroup" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL,
    "rules" TEXT,
    "coverImageUrl" VARCHAR(2000),
    "joinPolicy" "CommunityGroupJoinPolicy" NOT NULL DEFAULT 'open',
    "createdByUserId" TEXT NOT NULL,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "featuredOrder" INTEGER NOT NULL DEFAULT 0,
    "memberCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommunityGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityGroupMember" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CommunityGroupMemberRole" NOT NULL,
    "status" "CommunityGroupMemberStatus" NOT NULL,

    CONSTRAINT "CommunityGroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityGroup_slug_key" ON "CommunityGroup"("slug");

-- CreateIndex
CREATE INDEX "CommunityGroup_deletedAt_isFeatured_featuredOrder_idx" ON "CommunityGroup"("deletedAt", "isFeatured", "featuredOrder");

-- CreateIndex
CREATE INDEX "CommunityGroup_createdAt_idx" ON "CommunityGroup"("createdAt");

-- CreateIndex
CREATE INDEX "CommunityGroupMember_userId_status_idx" ON "CommunityGroupMember"("userId", "status");

-- CreateIndex
CREATE INDEX "CommunityGroupMember_groupId_status_idx" ON "CommunityGroupMember"("groupId", "status");

-- CreateIndex
CREATE INDEX "Post_communityGroupId_deletedAt_createdAt_id_idx" ON "Post"("communityGroupId", "deletedAt", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_communityGroupId_parentId_deletedAt_createdAt_id_idx" ON "Post"("communityGroupId", "parentId", "deletedAt", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "CommunityGroup" ADD CONSTRAINT "CommunityGroup_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityGroupMember" ADD CONSTRAINT "CommunityGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityGroupMember" ADD CONSTRAINT "CommunityGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_communityGroupId_fkey" FOREIGN KEY ("communityGroupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
