-- Add post boosts + cached score fields.

-- Add cached fields on Post.
ALTER TABLE "Post"
ADD COLUMN "boostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "boostScore" DOUBLE PRECISION,
ADD COLUMN "boostScoreUpdatedAt" TIMESTAMP(3);

-- Create Boost table.
CREATE TABLE "Boost" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,

  CONSTRAINT "Boost_pkey" PRIMARY KEY ("id")
);

-- One boost per user per post.
CREATE UNIQUE INDEX "Boost_postId_userId_key" ON "Boost"("postId", "userId");

-- Query-friendly indexes.
CREATE INDEX "Boost_postId_createdAt_idx" ON "Boost"("postId", "createdAt");
CREATE INDEX "Boost_userId_createdAt_idx" ON "Boost"("userId", "createdAt");

-- Foreign keys.
ALTER TABLE "Boost"
ADD CONSTRAINT "Boost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Boost"
ADD CONSTRAINT "Boost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

