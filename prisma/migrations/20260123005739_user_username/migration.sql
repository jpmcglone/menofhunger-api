-- AlterTable
ALTER TABLE "User" ADD COLUMN     "username" TEXT,
ADD COLUMN     "usernameIsSet" BOOLEAN NOT NULL DEFAULT false;
