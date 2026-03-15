-- CreateEnum
CREATE TYPE "CoinTransferKind" AS ENUM ('transfer', 'admin_adjust');

-- AlterTable
ALTER TABLE "CoinTransfer"
ADD COLUMN "kind" "CoinTransferKind" NOT NULL DEFAULT 'transfer';
