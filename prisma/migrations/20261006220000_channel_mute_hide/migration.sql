-- AlterTable
ALTER TABLE "GroupChannelViewerState" ADD COLUMN "mutedUntil" TIMESTAMP(3),
ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
