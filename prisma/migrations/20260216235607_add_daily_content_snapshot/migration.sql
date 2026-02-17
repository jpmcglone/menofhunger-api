-- CreateTable
CREATE TABLE "DailyContentSnapshot" (
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "quote" JSONB,
    "quoteRefreshedAt" TIMESTAMP(3),
    "websters1828" JSONB,
    "websters1828RefreshedAt" TIMESTAMP(3),
    "websters1828RecheckedAt" TIMESTAMP(3),

    CONSTRAINT "DailyContentSnapshot_pkey" PRIMARY KEY ("dayKey")
);

-- CreateIndex
CREATE INDEX "DailyContentSnapshot_updatedAt_idx" ON "DailyContentSnapshot"("updatedAt");
