-- Add media attachments for posts (images + GIFs).

CREATE TYPE "PostMediaKind" AS ENUM ('image', 'gif');
CREATE TYPE "PostMediaSource" AS ENUM ('upload', 'giphy');

CREATE TABLE "PostMedia" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "PostMediaKind" NOT NULL,
    "source" "PostMediaSource" NOT NULL,
    "r2Key" TEXT,
    "url" TEXT,
    "mp4Url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "postId" TEXT NOT NULL,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey"
FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "PostMedia_postId_position_idx" ON "PostMedia"("postId", "position");
CREATE INDEX "PostMedia_postId_createdAt_idx" ON "PostMedia"("postId", "createdAt");

