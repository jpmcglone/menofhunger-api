-- AlterTable
ALTER TABLE "Post" ADD COLUMN "topicsClassifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Post_topicsClassifiedAt_idx" ON "Post"("topicsClassifiedAt");

-- CreateIndex
CREATE INDEX "User_interests_idx" ON "User" USING GIN ("interests");

-- Luna drain: skip already-classified empties and only-me / group posts.
CREATE INDEX "Post_topics_ai_pending_idx"
ON "Post" ("createdAt" DESC, "id" DESC)
WHERE "deletedAt" IS NULL
  AND "communityGroupId" IS NULL
  AND "visibility" <> 'onlyMe'
  AND "topics" = '{}'
  AND "topicsClassifiedAt" IS NULL;
