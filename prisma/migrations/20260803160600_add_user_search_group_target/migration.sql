-- AlterTable
ALTER TABLE "UserSearch" ADD COLUMN     "targetGroupId" TEXT;

-- CreateIndex
CREATE INDEX "UserSearch_userId_targetGroupId_idx" ON "UserSearch"("userId", "targetGroupId");

-- AddForeignKey
ALTER TABLE "UserSearch" ADD CONSTRAINT "UserSearch_targetGroupId_fkey" FOREIGN KEY ("targetGroupId") REFERENCES "CommunityGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
