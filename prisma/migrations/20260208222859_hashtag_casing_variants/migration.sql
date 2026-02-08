-- AlterTable
ALTER TABLE "Hashtag" ADD COLUMN     "displayTag" TEXT,
ADD COLUMN     "displayTagCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "hashtagCasings" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "HashtagVariant" (
    "tag" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "HashtagVariant_pkey" PRIMARY KEY ("tag","variant")
);

-- CreateIndex
CREATE INDEX "HashtagVariant_tag_idx" ON "HashtagVariant"("tag");

-- CreateIndex
CREATE INDEX "HashtagVariant_count_idx" ON "HashtagVariant"("count");

-- AddForeignKey
ALTER TABLE "HashtagVariant" ADD CONSTRAINT "HashtagVariant_tag_fkey" FOREIGN KEY ("tag") REFERENCES "Hashtag"("tag") ON DELETE CASCADE ON UPDATE CASCADE;
