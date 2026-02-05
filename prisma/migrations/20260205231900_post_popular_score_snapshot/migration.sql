-- CreateTable
CREATE TABLE "PostPopularScoreSnapshot" (
    "asOf" TIMESTAMP(3) NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "userId" TEXT NOT NULL,
    "visibility" "PostVisibility" NOT NULL,
    "parentId" TEXT,
    "rootId" TEXT,

    CONSTRAINT "PostPopularScoreSnapshot_pkey" PRIMARY KEY ("asOf","postId")
);

-- CreateIndex
CREATE INDEX "PostPopularScoreSnapshot_asOf_score_createdAt_postId_idx" ON "PostPopularScoreSnapshot"("asOf", "score" DESC, "createdAt" DESC, "postId" DESC);

-- CreateIndex
CREATE INDEX "PostPopularScoreSnapshot_asOf_userId_idx" ON "PostPopularScoreSnapshot"("asOf", "userId");

-- CreateIndex
CREATE INDEX "PostPopularScoreSnapshot_asOf_visibility_idx" ON "PostPopularScoreSnapshot"("asOf", "visibility");

-- AddForeignKey
ALTER TABLE "PostPopularScoreSnapshot" ADD CONSTRAINT "PostPopularScoreSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostPopularScoreSnapshot" ADD CONSTRAINT "PostPopularScoreSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
