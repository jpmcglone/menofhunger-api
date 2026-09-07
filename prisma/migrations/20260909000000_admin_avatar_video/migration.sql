-- Persist the trusted administrator who initiated an avatar job for worker authorization.
ALTER TABLE "AvatarVideoUpload" ADD COLUMN "adminUserId" TEXT;
