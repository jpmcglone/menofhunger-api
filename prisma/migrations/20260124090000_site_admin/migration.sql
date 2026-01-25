-- Add a minimal site-wide admin flag (roles/permissions later).
ALTER TABLE "User"
ADD COLUMN "siteAdmin" BOOLEAN NOT NULL DEFAULT false;

