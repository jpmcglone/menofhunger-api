-- Add composite index on User to support the checkin leaderboard sort
-- (ORDER BY checkinStreakDays DESC, longestStreakDays DESC, createdAt ASC WHERE bannedAt IS NULL).
-- Prisma represents this as @@index([bannedAt, checkinStreakDays(sort: Desc), longestStreakDays(sort: Desc), createdAt(sort: Asc)]).
CREATE INDEX IF NOT EXISTS "User_bannedAt_checkinStreakDays_longestStreakDays_createdAt_idx"
  ON "User" ("bannedAt" ASC, "checkinStreakDays" DESC, "longestStreakDays" DESC, "createdAt" ASC);
