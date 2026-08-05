-- AlterTable
ALTER TABLE "FitnessActivity" ADD COLUMN     "avgHeartrate" DOUBLE PRECISION,
ADD COLUMN     "calories" DOUBLE PRECISION,
ADD COLUMN     "maxHeartrate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FitnessBodyMetric" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'weight';

-- CreateIndex
CREATE INDEX "FitnessBodyMetric_userId_kind_measuredAt_idx" ON "FitnessBodyMetric"("userId", "kind", "measuredAt" DESC);
