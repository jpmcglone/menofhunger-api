ALTER TABLE "User" ADD COLUMN "avatarVideoKey" TEXT,
  ADD COLUMN "avatarVideoDurationMs" INTEGER,
  ADD COLUMN "avatarRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AvatarVideoUpload" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operatorUserId" TEXT,
  "sourceKey" TEXT NOT NULL,
  "videoKey" TEXT NOT NULL,
  "posterKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'uploading',
  "selection" JSONB,
  "revision" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AvatarVideoUpload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvatarVideoUpload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AvatarVideoUpload_sourceKey_key" ON "AvatarVideoUpload"("sourceKey");
CREATE UNIQUE INDEX "AvatarVideoUpload_videoKey_key" ON "AvatarVideoUpload"("videoKey");
CREATE UNIQUE INDEX "AvatarVideoUpload_posterKey_key" ON "AvatarVideoUpload"("posterKey");
CREATE INDEX "AvatarVideoUpload_userId_createdAt_idx" ON "AvatarVideoUpload"("userId", "createdAt");
CREATE INDEX "AvatarVideoUpload_status_updatedAt_idx" ON "AvatarVideoUpload"("status", "updatedAt");
