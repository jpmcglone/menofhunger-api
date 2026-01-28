-- Add soft delete marker to Post
ALTER TABLE "Post"
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Helpful index for filtering out deleted posts
CREATE INDEX "Post_deletedAt_idx" ON "Post"("deletedAt");

