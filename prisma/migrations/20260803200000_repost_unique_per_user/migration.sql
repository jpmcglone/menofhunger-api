-- One flat repost per (userId, repostedPostId) while the row is live.
-- Partial index: only enforces uniqueness when kind='repost' AND deletedAt IS NULL.
-- Un-reposting soft-deletes the row, so a second repost (on a fresh row) is allowed
-- without violating the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "Post_repost_user_canonical_unique"
  ON "Post" ("userId", "repostedPostId")
  WHERE "kind" = 'repost' AND "deletedAt" IS NULL;
