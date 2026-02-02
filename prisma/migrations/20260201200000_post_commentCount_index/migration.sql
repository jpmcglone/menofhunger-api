-- Index to support "popular" feed candidate selection by commentCount.
-- Mirrors Post_boostCount_createdAt_notDeleted_idx and Post_bookmarkCount_createdAt_notDeleted_idx
-- for the "commented" bucket in listPopularFeed.

CREATE INDEX "Post_commentCount_createdAt_notDeleted_idx"
ON "Post" ("commentCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL;
