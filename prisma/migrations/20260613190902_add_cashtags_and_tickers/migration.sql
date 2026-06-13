-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "cashtags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "PostVersion" ADD COLUMN     "cashtags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Ticker" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'sec',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticker_pkey" PRIMARY KEY ("symbol")
);

-- CreateIndex
CREATE INDEX "Ticker_name_idx" ON "Ticker"("name");

-- CreateIndex
CREATE INDEX "Post_cashtags_idx" ON "Post" USING GIN ("cashtags");
