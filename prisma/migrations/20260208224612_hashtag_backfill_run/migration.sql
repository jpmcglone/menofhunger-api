-- CreateTable
CREATE TABLE "HashtagBackfillRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "cursor" TEXT,
    "processedPosts" INTEGER NOT NULL DEFAULT 0,
    "updatedPosts" INTEGER NOT NULL DEFAULT 0,
    "resetDone" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "HashtagBackfillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HashtagBackfillRun_status_updatedAt_idx" ON "HashtagBackfillRun"("status", "updatedAt");
