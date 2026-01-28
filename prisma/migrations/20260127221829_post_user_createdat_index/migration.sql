-- DropIndex
DROP INDEX "Post_userId_idx";

-- CreateIndex
CREATE INDEX "Post_userId_createdAt_idx" ON "Post"("userId", "createdAt");
