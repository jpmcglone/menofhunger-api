-- Add new username columns.
ALTER TABLE "User"
ADD COLUMN "usernameDisplay" TEXT,
ADD COLUMN "usernameLower" TEXT;

-- Backfill from old `username` column if present.
UPDATE "User"
SET
  "usernameDisplay" = "username",
  "usernameLower" = LOWER("username")
WHERE "username" IS NOT NULL;

-- Drop old column.
ALTER TABLE "User" DROP COLUMN "username";

-- Enforce case-insensitive uniqueness via canonical lowercase column.
CREATE UNIQUE INDEX "User_usernameLower_key" ON "User"("usernameLower");

