-- Indexes to support "popular" feed warmup + filtering.
-- Popular ordering uses a time-decayed expression (not index-friendly),
-- but we can index the warmup path (boostCount) and score staleness checks.

CREATE INDEX "Post_boostCount_createdAt_notDeleted_idx"
ON "Post" ("boostCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL;

CREATE INDEX "Post_boostScoreUpdatedAt_notDeleted_idx"
ON "Post" ("boostScoreUpdatedAt")
WHERE "deletedAt" IS NULL;

