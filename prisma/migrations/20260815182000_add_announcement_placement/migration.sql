-- CreateEnum
CREATE TYPE "AnnouncementPlacement" AS ENUM ('overlay', 'inline');

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "placement" "AnnouncementPlacement" NOT NULL DEFAULT 'overlay';
ALTER TABLE "Announcement" ALTER COLUMN "title" SET DEFAULT '';
