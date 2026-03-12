-- AlterEnum
ALTER TYPE "PostKind" ADD VALUE 'articleShare';

-- DropIndex
DROP INDEX "Message_deletedForAll_idx";

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "articleId" TEXT;

-- AlterTable
ALTER TABLE "PushCoalesce" ALTER COLUMN "sentAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "articleBio" TEXT;

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '{}',
    "excerpt" TEXT,
    "thumbnailR2Key" TEXT,
    "visibility" "PostVisibility" NOT NULL DEFAULT 'public',
    "isDraft" BOOLEAN NOT NULL DEFAULT true,
    "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boostCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleBoost" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "articleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ArticleBoost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleReaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "articleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reactionId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "ArticleReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleComment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "body" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "replyCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ArticleComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleCommentReaction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reactionId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,

    CONSTRAINT "ArticleCommentReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Article_authorId_createdAt_idx" ON "Article"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "Article_publishedAt_id_idx" ON "Article"("publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Article_deletedAt_idx" ON "Article"("deletedAt");

-- CreateIndex
CREATE INDEX "Article_slug_idx" ON "Article"("slug");

-- CreateIndex
CREATE INDEX "ArticleBoost_articleId_createdAt_idx" ON "ArticleBoost"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "ArticleBoost_userId_createdAt_idx" ON "ArticleBoost"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleBoost_articleId_userId_key" ON "ArticleBoost"("articleId", "userId");

-- CreateIndex
CREATE INDEX "ArticleReaction_articleId_idx" ON "ArticleReaction"("articleId");

-- CreateIndex
CREATE INDEX "ArticleReaction_userId_createdAt_idx" ON "ArticleReaction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleReaction_articleId_userId_reactionId_key" ON "ArticleReaction"("articleId", "userId", "reactionId");

-- CreateIndex
CREATE INDEX "ArticleComment_articleId_createdAt_idx" ON "ArticleComment"("articleId", "createdAt");

-- CreateIndex
CREATE INDEX "ArticleComment_parentId_createdAt_idx" ON "ArticleComment"("parentId", "createdAt");

-- CreateIndex
CREATE INDEX "ArticleComment_authorId_createdAt_idx" ON "ArticleComment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "ArticleCommentReaction_commentId_idx" ON "ArticleCommentReaction"("commentId");

-- CreateIndex
CREATE INDEX "ArticleCommentReaction_userId_createdAt_idx" ON "ArticleCommentReaction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleCommentReaction_commentId_userId_reactionId_key" ON "ArticleCommentReaction"("commentId", "userId", "reactionId");

-- CreateIndex
CREATE INDEX "Post_articleId_idx" ON "Post"("articleId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleBoost" ADD CONSTRAINT "ArticleBoost_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleBoost" ADD CONSTRAINT "ArticleBoost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleReaction" ADD CONSTRAINT "ArticleReaction_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleReaction" ADD CONSTRAINT "ArticleReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleComment" ADD CONSTRAINT "ArticleComment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleComment" ADD CONSTRAINT "ArticleComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleComment" ADD CONSTRAINT "ArticleComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ArticleComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCommentReaction" ADD CONSTRAINT "ArticleCommentReaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ArticleComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCommentReaction" ADD CONSTRAINT "ArticleCommentReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
