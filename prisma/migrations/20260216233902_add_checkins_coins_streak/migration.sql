-- Add check-in post classification + private user rewards.

-- Create enum for post kind.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PostKind') THEN
    CREATE TYPE "PostKind" AS ENUM ('regular', 'checkin');
  END IF;
END $$;

-- User: private coins/streak.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "coins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "checkinStreakDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lastCheckinDayKey" TEXT;

-- Post: check-in classification + prompt.
ALTER TABLE "Post"
ADD COLUMN IF NOT EXISTS "kind" "PostKind" NOT NULL DEFAULT 'regular',
ADD COLUMN IF NOT EXISTS "checkinDayKey" TEXT,
ADD COLUMN IF NOT EXISTS "checkinPrompt" TEXT;

-- Index/filter support.
CREATE INDEX IF NOT EXISTS "Post_kind_createdAt_idx" ON "Post" ("kind", "createdAt");

-- One check-in per user per ET day (null day keys do not collide).
CREATE UNIQUE INDEX IF NOT EXISTS "Post_userId_kind_checkinDayKey_key" ON "Post" ("userId", "kind", "checkinDayKey");

