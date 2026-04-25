-- Support personalized feed lookups by viewer over a candidate post id set.
CREATE INDEX "PostView_userId_postId_idx" ON "PostView"("userId", "postId");
