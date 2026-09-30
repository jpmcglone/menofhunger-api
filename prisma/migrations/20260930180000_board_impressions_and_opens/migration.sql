-- Additive: old clients still report impressions. Preserve prior Board visits for
-- the "comments since last opened" marker; do not invent historical open counts.
ALTER TABLE "PostView" ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastOpenedAt" TIMESTAMP(3);
ALTER TABLE "PostAnonView" ADD COLUMN "openCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastOpenedAt" TIMESTAMP(3);
UPDATE "PostView" v SET "lastOpenedAt" = v."lastSeenAt"
  FROM "Post" p WHERE p."id" = v."postId" AND p."kind" = 'board';
