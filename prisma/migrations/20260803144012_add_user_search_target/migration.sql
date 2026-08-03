-- AlterTable
ALTER TABLE "UserSearch" ADD COLUMN "targetUserId" TEXT;

-- CreateIndex
CREATE INDEX "UserSearch_userId_targetUserId_idx" ON "UserSearch"("userId", "targetUserId");

-- AddForeignKey
ALTER TABLE "UserSearch" ADD CONSTRAINT "UserSearch_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
