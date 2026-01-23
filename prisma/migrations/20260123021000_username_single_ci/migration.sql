-- Move to a single username field (case-preserving) and enforce uniqueness case-insensitively.

-- 1) Add the new column.
ALTER TABLE "User"
ADD COLUMN "username" TEXT;

-- 2) Backfill from prior columns if present.
UPDATE "User"
SET "username" = COALESCE("usernameDisplay", "usernameLower", "username")
WHERE "username" IS NULL;

-- 3) Drop old unique index/columns (if they exist from previous iterations).
DROP INDEX IF EXISTS "User_usernameLower_key";

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "usernameLower",
  DROP COLUMN IF EXISTS "usernameDisplay";

-- 4) Enforce case-insensitive uniqueness on username (allow multiple NULLs).
CREATE UNIQUE INDEX "User_username_lower_ci_key"
  ON "User" (LOWER("username"))
  WHERE "username" IS NOT NULL;

