-- CreateTable
CREATE TABLE "AdminIntroBrief" (
    "id" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "pairsJson" JSONB NOT NULL,
    "modelUsed" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminIntroBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminIntroBrief_weekKey_key" ON "AdminIntroBrief"("weekKey");

-- CreateIndex
CREATE INDEX "AdminIntroBrief_createdAt_idx" ON "AdminIntroBrief"("createdAt");
