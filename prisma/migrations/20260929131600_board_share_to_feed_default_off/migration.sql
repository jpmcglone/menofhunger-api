-- "Also post to feed" starts off for Board posts and article cross-posts.
-- Existing accounts were created with the previous on-default, so reset that remembered choice.
ALTER TABLE "User" ALTER COLUMN "boardShareToFeedDefault" SET DEFAULT false;
UPDATE "User" SET "boardShareToFeedDefault" = false WHERE "boardShareToFeedDefault" = true;

-- New Board threads stay off the feed unless the author opts in. Existing threads are unchanged.
ALTER TABLE "BoardThread" ALTER COLUMN "showInFeed" SET DEFAULT false;
