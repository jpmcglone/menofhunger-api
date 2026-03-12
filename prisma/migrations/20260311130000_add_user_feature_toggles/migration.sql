-- Add per-user app feature toggles (admin-managed).
ALTER TABLE "User"
ADD COLUMN "featureToggles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
