-- Add onboarding fields to User
ALTER TABLE "User"
ADD COLUMN "birthdate" TIMESTAMP(3),
ADD COLUMN "interests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

