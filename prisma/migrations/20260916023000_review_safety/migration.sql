-- AlterTable
ALTER TABLE "User" ADD COLUMN     "appleSandboxExpiresAt" TIMESTAMP(3),
ADD COLUMN     "appleSandboxOriginalTransactionId" TEXT,
ADD COLUMN     "appleSandboxProductId" TEXT,
ADD COLUMN     "appleSandboxStatus" TEXT;

-- AlterTable
ALTER TABLE "MarvinUserSettings" ADD COLUMN     "aiConsentAt" TIMESTAMP(3),
ADD COLUMN     "aiConsentVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AccountDeletionReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "erasedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "confirmationEmail" TEXT,
    "mediaKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionReceipt_userId_key" ON "AccountDeletionReceipt"("userId");

-- CreateIndex
CREATE INDEX "AccountDeletionReceipt_scheduledAt_completedAt_idx" ON "AccountDeletionReceipt"("scheduledAt", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_appleSandboxOriginalTransactionId_key" ON "User"("appleSandboxOriginalTransactionId");


-- Preserve older verified test purchases in the isolated Sandbox fields.
UPDATE "User" SET
  "appleSandboxOriginalTransactionId" = "appleOriginalTransactionId",
  "appleSandboxProductId" = "appleProductId",
  "appleSandboxStatus" = "appleStatus",
  "appleSandboxExpiresAt" = "appleExpiresAt",
  "appleOriginalTransactionId" = NULL,
  "appleProductId" = NULL,
  "appleStatus" = NULL,
  "appleExpiresAt" = NULL,
  "appleAutoRenew" = false,
  "appleEnvironment" = NULL
WHERE lower("appleEnvironment") = 'sandbox';
