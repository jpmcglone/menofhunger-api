-- DropIndex
DROP INDEX "Article_slug_idx";

-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "weightedViewCount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "weightedViewCount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PostAnonView" (
    "postId" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostAnonView_pkey" PRIMARY KEY ("postId","anonId")
);

-- CreateTable
CREATE TABLE "ArticleAnonView" (
    "articleId" TEXT NOT NULL,
    "anonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleAnonView_pkey" PRIMARY KEY ("articleId","anonId")
);

-- CreateIndex
CREATE INDEX "PostAnonView_postId_idx" ON "PostAnonView"("postId");

-- CreateIndex
CREATE INDEX "ArticleAnonView_articleId_idx" ON "ArticleAnonView"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "Article_slug_key" ON "Article"("slug");

-- AddForeignKey
ALTER TABLE "PostAnonView" ADD CONSTRAINT "PostAnonView_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleAnonView" ADD CONSTRAINT "ArticleAnonView_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
