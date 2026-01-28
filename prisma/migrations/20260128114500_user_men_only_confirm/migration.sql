-- Add men-only community acknowledgement to User
ALTER TABLE "User"
ADD COLUMN "menOnlyConfirmed" BOOLEAN NOT NULL DEFAULT false;

