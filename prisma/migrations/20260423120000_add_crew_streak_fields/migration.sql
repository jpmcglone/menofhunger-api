-- Strict crew streak fields. All additive + safe defaults so existing crews land at 0.
ALTER TABLE "Crew" ADD COLUMN "currentStreakDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Crew" ADD COLUMN "longestStreakDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Crew" ADD COLUMN "lastCompletedDayKey" TEXT;
