CREATE TABLE "IntegrationReconciliation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "operationId" TEXT NOT NULL,
  "adminUserId" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "previousChargedMicros" INTEGER,
  "chargedMicros" INTEGER NOT NULL CHECK ("chargedMicros" >= 0),
  "evidence" TEXT NOT NULL
);
CREATE INDEX "IntegrationReconciliation_operationId_createdAt_idx" ON "IntegrationReconciliation"("operationId", "createdAt");
