-- CreateIndex
CREATE INDEX "Post_deletedAt_isDraft_kind_visibility_idx" ON "Post"("deletedAt", "isDraft", "kind", "visibility");
