-- Unverify all emails.
-- After this, users must verify to receive email-based notifications/digests.

UPDATE "User"
SET
  "emailVerifiedAt" = NULL,
  "emailVerificationRequestedAt" = NULL
WHERE "email" IS NOT NULL;

-- Invalidate any outstanding verify-email tokens (best-effort hygiene).
UPDATE "EmailActionToken"
SET "consumedAt" = COALESCE("consumedAt", CURRENT_TIMESTAMP)
WHERE "purpose" = 'verifyEmail';

