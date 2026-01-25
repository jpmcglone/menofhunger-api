-- Verified badge support (status + timestamps).
CREATE TYPE "VerifiedStatus" AS ENUM ('none', 'identity', 'manual');

ALTER TABLE "User"
ADD COLUMN "verifiedStatus" "VerifiedStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "unverifiedAt" TIMESTAMP(3);

