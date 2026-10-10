CREATE TABLE "MediaUploadGrant" (
    "userId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "contentType" TEXT NOT NULL,
    "kind" "PostMediaKind" NOT NULL,
    "bytes" INTEGER,
    "etag" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "thumbnailR2Key" TEXT,
    CONSTRAINT "MediaUploadGrant_pkey" PRIMARY KEY ("userId", "r2Key")
);
CREATE INDEX "MediaUploadGrant_expiresAt_idx" ON "MediaUploadGrant"("expiresAt");
CREATE INDEX "MediaUploadGrant_r2Key_idx" ON "MediaUploadGrant"("r2Key");
CREATE INDEX "MediaUploadGrant_thumbnailR2Key_idx" ON "MediaUploadGrant"("thumbnailR2Key");
ALTER TABLE "MediaUploadGrant" ADD CONSTRAINT "MediaUploadGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
