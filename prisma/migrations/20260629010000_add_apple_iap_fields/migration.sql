-- Migration: add_apple_iap_fields
--
-- Adds Apple IAP subscription state to the User table so Apple becomes
-- another entitlement source alongside Stripe and manual grants.
-- The effective tier is always max(stripe, apple, grants) — both coexist.

ALTER TABLE "User"
  ADD COLUMN "appleOriginalTransactionId" TEXT,
  ADD COLUMN "appleProductId"             TEXT,
  ADD COLUMN "appleStatus"                TEXT,
  ADD COLUMN "appleExpiresAt"             TIMESTAMP(3),
  ADD COLUMN "appleAutoRenew"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "appleEnvironment"           TEXT;

CREATE UNIQUE INDEX "User_appleOriginalTransactionId_key"
  ON "User"("appleOriginalTransactionId");
