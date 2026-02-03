-- Partial indexes for trending (popular) feed so each candidate bucket and comment_scores
-- uses a smaller, targeted index. Cuts planning and scan cost vs. full-table or broader indexes.

-- Recency bucket: top-level posts only, by visibility and time.
CREATE INDEX "Post_visibility_createdAt_topLevel_notDeleted_idx"
ON "Post" ("visibility", "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL AND "parentId" IS NULL;

-- Boosted bucket: top-level posts only.
CREATE INDEX "Post_boostCount_createdAt_topLevel_notDeleted_idx"
ON "Post" ("boostCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL AND "parentId" IS NULL;

-- Bookmarked bucket: top-level posts only.
CREATE INDEX "Post_bookmarkCount_createdAt_topLevel_notDeleted_idx"
ON "Post" ("bookmarkCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL AND "parentId" IS NULL;

-- Commented bucket: top-level posts only.
CREATE INDEX "Post_commentCount_createdAt_topLevel_notDeleted_idx"
ON "Post" ("commentCount" DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL AND "parentId" IS NULL;

-- Replies bucket: ORDER BY (boostCount + bookmarkCount) DESC.
CREATE INDEX "Post_replies_engagement_notDeleted_idx"
ON "Post" (("boostCount" + "bookmarkCount") DESC, "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL AND "parentId" IS NOT NULL;

-- comment_scores CTE: replies only, by parent and time.
CREATE INDEX "Post_parentId_createdAt_replies_notDeleted_idx"
ON "Post" ("parentId", "createdAt")
WHERE "deletedAt" IS NULL AND "parentId" IS NOT NULL;
