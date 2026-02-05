-- Full-text search (FTS) indexes for SearchService.
-- Notes:
-- - We use expression GIN indexes to avoid Prisma schema drift issues with generated tsvector columns.
-- - These are safe to run on existing data; on very large DBs consider scheduling during low-traffic.

-- Posts: body search (exclude soft-deleted)
CREATE INDEX "Post_body_fts_notDeleted_idx"
ON "Post"
USING GIN (to_tsvector('english', "body"))
WHERE "deletedAt" IS NULL;

-- Users: profile search (username/name/bio), primarily for finding authors quickly
CREATE INDEX "User_profile_fts_usernameIsSet_idx"
ON "User"
USING GIN (
  to_tsvector(
    'english',
    COALESCE("username", '') || ' ' || COALESCE("name", '') || ' ' || COALESCE("bio", '')
  )
)
WHERE "usernameIsSet" = true;

