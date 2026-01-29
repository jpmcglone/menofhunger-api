-- Feed query index improvements (optimize common WHERE + ORDER BY paths).
-- Most feed queries filter `deletedAt IS NULL` and sort by `createdAt DESC, id DESC`,
-- sometimes additionally filtering by `visibility` and/or `userId`.

-- Fast path for public feed browsing by visibility.
CREATE INDEX "Post_visibility_createdAt_notDeleted_idx"
ON "Post" ("visibility", "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL;

-- Fast path for per-user lists (profile posts).
CREATE INDEX "Post_userId_visibility_createdAt_notDeleted_idx"
ON "Post" ("userId", "visibility", "createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL;

