-- CreateTable
CREATE TABLE "ApnsDeviceToken" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',

    CONSTRAINT "ApnsDeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApnsDeviceToken_token_key" ON "ApnsDeviceToken"("token");

-- CreateIndex
CREATE INDEX "ApnsDeviceToken_userId_idx" ON "ApnsDeviceToken"("userId");

-- AddForeignKey
ALTER TABLE "ApnsDeviceToken" ADD CONSTRAINT "ApnsDeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
