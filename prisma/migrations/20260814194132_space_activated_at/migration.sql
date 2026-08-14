-- AlterTable
ALTER TABLE "Space" ADD COLUMN     "activatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Space_activatedAt_idx" ON "Space"("activatedAt");
