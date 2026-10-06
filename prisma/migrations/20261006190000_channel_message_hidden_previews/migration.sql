-- AlterTable
ALTER TABLE "Message" ADD COLUMN "hiddenPreviews" TEXT[] DEFAULT ARRAY[]::TEXT[];
