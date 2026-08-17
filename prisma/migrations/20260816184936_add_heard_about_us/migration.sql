-- CreateEnum
CREATE TYPE "HeardAboutUs" AS ENUM ('friend', 'google', 'x', 'youtube', 'nxr', 'church', 'podcast', 'prefer_not', 'other');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "heardAboutUs" "HeardAboutUs",
ADD COLUMN     "heardAboutUsOther" TEXT;
