-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'coin_transfer';

-- CreateTable
CREATE TABLE "CoinTransfer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "CoinTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoinTransfer_senderId_createdAt_idx" ON "CoinTransfer"("senderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CoinTransfer_recipientId_createdAt_idx" ON "CoinTransfer"("recipientId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "CoinTransfer" ADD CONSTRAINT "CoinTransfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinTransfer" ADD CONSTRAINT "CoinTransfer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
