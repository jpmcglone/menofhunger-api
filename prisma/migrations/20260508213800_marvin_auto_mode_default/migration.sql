-- Set 'auto' as the default for new MarvinUserSettings rows.
-- Existing rows keep their stored preference unchanged.

ALTER TABLE "MarvinUserSettings" ALTER COLUMN "preferredMode" SET DEFAULT 'auto';
