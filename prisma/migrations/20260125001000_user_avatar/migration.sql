-- User avatar support (keys live in object storage).
ALTER TABLE "User"
ADD COLUMN "avatarKey" TEXT,
ADD COLUMN "avatarUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_avatarKey_idx" ON "User"("avatarKey");

