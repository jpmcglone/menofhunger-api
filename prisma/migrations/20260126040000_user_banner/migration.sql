-- Add banner fields for user profiles (stored as object storage keys).
ALTER TABLE "User"
  ADD COLUMN "bannerKey" TEXT,
  ADD COLUMN "bannerUpdatedAt" TIMESTAMP(3);

