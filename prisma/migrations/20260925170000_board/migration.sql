-- AlterEnum
ALTER TYPE "PostKind" ADD VALUE 'board';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "articlePostToBoardDefault" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "boardShareToFeedDefault" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "boardOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BoardThread" (
    "postId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "urlNormalized" TEXT,
    "domain" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "showInFeed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardThread_pkey" PRIMARY KEY ("postId")
);

-- CreateTable
CREATE TABLE "BoardTag" (
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "threadCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardTag_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "BoardHide" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardHide_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateIndex
CREATE INDEX "BoardThread_createdAt_idx" ON "BoardThread"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "BoardThread_domain_createdAt_idx" ON "BoardThread"("domain", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BoardThread_urlNormalized_createdAt_idx" ON "BoardThread"("urlNormalized", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BoardThread_tags_idx" ON "BoardThread" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "BoardTag_threadCount_idx" ON "BoardTag"("threadCount" DESC);

-- CreateIndex
CREATE INDEX "BoardHide_postId_idx" ON "BoardHide"("postId");

-- CreateIndex
CREATE INDEX "Post_boardOnly_idx" ON "Post"("boardOnly");

-- AddForeignKey
ALTER TABLE "BoardThread" ADD CONSTRAINT "BoardThread_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardHide" ADD CONSTRAINT "BoardHide_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardHide" ADD CONSTRAINT "BoardHide_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

