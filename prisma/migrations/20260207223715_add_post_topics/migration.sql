-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "topics" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Post_topics_idx" ON "Post" USING GIN ("topics");
