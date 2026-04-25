ALTER TABLE "PostView"
ADD COLUMN "lastSeenAt" TIMESTAMP(3),
ADD COLUMN "seenCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "lastSource" TEXT;

UPDATE "PostView"
SET "lastSeenAt" = "createdAt"
WHERE "lastSeenAt" IS NULL;

ALTER TABLE "PostView"
ALTER COLUMN "lastSeenAt" SET NOT NULL,
ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "PostView_userId_lastSeenAt_idx" ON "PostView"("userId", "lastSeenAt");
