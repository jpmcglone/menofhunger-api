-- CreateTable
CREATE TABLE "HashtagTrendingScoreSnapshot" (
    "asOf" TIMESTAMP(3) NOT NULL,
    "tag" TEXT NOT NULL,
    "visibility" "PostVisibility" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "usageCount" INTEGER NOT NULL,

    CONSTRAINT "HashtagTrendingScoreSnapshot_pkey" PRIMARY KEY ("asOf","visibility","tag")
);

-- CreateIndex
CREATE INDEX "HashtagTrendingScoreSnapshot_asOf_visibility_score_usageCount_tag_idx" ON "HashtagTrendingScoreSnapshot"("asOf", "visibility", "score" DESC, "usageCount" DESC, "tag" ASC);

-- CreateIndex
CREATE INDEX "HashtagTrendingScoreSnapshot_asOf_tag_idx" ON "HashtagTrendingScoreSnapshot"("asOf", "tag");

