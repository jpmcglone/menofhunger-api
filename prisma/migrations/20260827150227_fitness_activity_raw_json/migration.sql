-- AlterTable
ALTER TABLE "FitnessActivity" ADD COLUMN     "name" TEXT,
ADD COLUMN     "rawJson" JSONB;

-- AlterTable
ALTER TABLE "FitnessConnection" ADD COLUMN     "profileJson" JSONB;
