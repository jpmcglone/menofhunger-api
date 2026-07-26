-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "impersonatedByUserId" TEXT;

-- CreateTable
CREATE TABLE "AdminImpersonationLog" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "adminUserId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,

    CONSTRAINT "AdminImpersonationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminImpersonationLog_adminUserId_startedAt_idx" ON "AdminImpersonationLog"("adminUserId", "startedAt");

-- CreateIndex
CREATE INDEX "AdminImpersonationLog_targetUserId_startedAt_idx" ON "AdminImpersonationLog"("targetUserId", "startedAt");

-- CreateIndex
CREATE INDEX "AdminImpersonationLog_sessionId_idx" ON "AdminImpersonationLog"("sessionId");

-- CreateIndex
CREATE INDEX "Session_impersonatedByUserId_idx" ON "Session"("impersonatedByUserId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_impersonatedByUserId_fkey" FOREIGN KEY ("impersonatedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminImpersonationLog" ADD CONSTRAINT "AdminImpersonationLog_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminImpersonationLog" ADD CONSTRAINT "AdminImpersonationLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
