-- Additive Android registry. No existing rows/tables are rewritten.
CREATE TABLE "FcmDeviceRegistration" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installationId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    CONSTRAINT "FcmDeviceRegistration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FcmDeviceRegistration_installationId_key" ON "FcmDeviceRegistration"("installationId");
CREATE UNIQUE INDEX "FcmDeviceRegistration_token_key" ON "FcmDeviceRegistration"("token");
CREATE INDEX "FcmDeviceRegistration_userId_idx" ON "FcmDeviceRegistration"("userId");
CREATE INDEX "FcmDeviceRegistration_sessionId_idx" ON "FcmDeviceRegistration"("sessionId");
CREATE INDEX "FcmDeviceRegistration_lastSeenAt_idx" ON "FcmDeviceRegistration"("lastSeenAt");

ALTER TABLE "FcmDeviceRegistration" ADD CONSTRAINT "FcmDeviceRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FcmDeviceRegistration" ADD CONSTRAINT "FcmDeviceRegistration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
