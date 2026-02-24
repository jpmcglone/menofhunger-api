-- CreateTable
CREATE TABLE "AdminEmailLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminEmailLog_sentAt_idx" ON "AdminEmailLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminEmailLog_kind_dayKey_key" ON "AdminEmailLog"("kind", "dayKey");
