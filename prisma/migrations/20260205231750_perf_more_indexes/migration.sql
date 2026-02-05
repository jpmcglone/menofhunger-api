-- CreateIndex
CREATE INDEX "Follow_followingId_followerId_idx" ON "Follow"("followingId", "followerId");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_id_idx" ON "Notification"("recipientUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_parentId_deletedAt_createdAt_id_idx" ON "Post"("parentId", "deletedAt", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_parentId_deletedAt_boostCount_createdAt_id_idx" ON "Post"("parentId", "deletedAt", "boostCount" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_parentId_deletedAt_bookmarkCount_createdAt_id_idx" ON "Post"("parentId", "deletedAt", "bookmarkCount" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Post_parentId_deletedAt_commentCount_createdAt_id_idx" ON "Post"("parentId", "deletedAt", "commentCount" DESC, "createdAt" DESC, "id" DESC);
