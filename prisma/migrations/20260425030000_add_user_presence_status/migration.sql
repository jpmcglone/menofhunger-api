ALTER TABLE "User"
ADD COLUMN "statusText" TEXT,
ADD COLUMN "statusSetAt" TIMESTAMP(3),
ADD COLUMN "statusExpiresAt" TIMESTAMP(3);

CREATE INDEX "User_statusExpiresAt_idx" ON "User"("statusExpiresAt");
