-- AlterTable
ALTER TABLE "SiteConfig" ADD COLUMN     "premiumPostsPerWindow" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "premiumWindowSeconds" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "verifiedPostsPerWindow" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "verifiedWindowSeconds" INTEGER NOT NULL DEFAULT 300;

-- RenameIndex
ALTER INDEX "HashtagTrendingScoreSnapshot_asOf_visibility_score_usageCount_t" RENAME TO "HashtagTrendingScoreSnapshot_asOf_visibility_score_usageCou_idx";
