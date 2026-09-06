ALTER TABLE "CoinTransfer" ADD COLUMN "postId" TEXT;
CREATE INDEX "CoinTransfer_postId_createdAt_idx" ON "CoinTransfer"("postId", "createdAt");
ALTER TABLE "CoinTransfer" ADD CONSTRAINT "CoinTransfer_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
