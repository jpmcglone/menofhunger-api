-- Add optional pinned post to User (one per user; must be own post; enforced in API).
ALTER TABLE "User" ADD COLUMN "pinnedPostId" TEXT;

CREATE UNIQUE INDEX "User_pinnedPostId_key" ON "User"("pinnedPostId");

ALTER TABLE "User" ADD CONSTRAINT "User_pinnedPostId_fkey"
  FOREIGN KEY ("pinnedPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
