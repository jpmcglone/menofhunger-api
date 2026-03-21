-- AlterTable
ALTER TABLE "CommunityGroup" ADD COLUMN "avatarImageUrl" VARCHAR(2000);

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "pinnedInGroupAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Post_communityGroupId_pinnedInGroupAt_idx" ON "Post"("communityGroupId", "pinnedInGroupAt");
