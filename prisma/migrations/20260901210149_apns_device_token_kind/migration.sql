-- AlterTable
ALTER TABLE "ApnsDeviceToken" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'alert';
