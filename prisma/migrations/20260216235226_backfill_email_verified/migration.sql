-- Backfill: treat existing emails as verified so behavior doesn't regress.
-- New/changed emails are marked unverified and require verification link.

UPDATE "User"
SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", "createdAt")
WHERE "email" IS NOT NULL
  AND "emailVerifiedAt" IS NULL;

