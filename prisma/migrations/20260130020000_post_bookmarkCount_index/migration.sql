-- Index to support "popular" feed candidate selection by bookmarkCount.
-- Popular scoring uses a time-decayed expression (not index-friendly),
-- but we bound candidates by top bookmarked in the lookback window.

CREATE INDEX "Post_bookmarkCount_createdAt_notDeleted_idx"
ON "Post" ("bookmarkCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL;

