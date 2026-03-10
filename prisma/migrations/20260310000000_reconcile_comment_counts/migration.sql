-- Reconcile denormalized commentCount against actual non-deleted children.
-- This corrects drift that accumulated before deletePost began decrementing
-- the counter (comments that were soft-deleted without updating the parent).
-- Applies to all posts (top-level and nested) that may have children.
UPDATE "Post" p
SET "commentCount" = (
  SELECT COUNT(*)::int
  FROM "Post" c
  WHERE c."parentId" = p."id"
    AND c."deletedAt" IS NULL
);
