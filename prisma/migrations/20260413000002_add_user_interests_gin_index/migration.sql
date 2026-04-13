-- GIN index on User.interests array column to accelerate the && (overlap) operator
-- used by follow recommendations (recommendArenaUsersToFollow).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_interests_gin_idx"
  ON "User" USING GIN ("interests");
