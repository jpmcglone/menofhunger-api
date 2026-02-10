-- CreateTable
CREATE TABLE "NotificationPreferences" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pushComment" BOOLEAN NOT NULL DEFAULT true,
    "pushBoost" BOOLEAN NOT NULL DEFAULT true,
    "pushFollow" BOOLEAN NOT NULL DEFAULT true,
    "pushMention" BOOLEAN NOT NULL DEFAULT true,
    "pushMessage" BOOLEAN NOT NULL DEFAULT true,
    "emailDigestWeekly" BOOLEAN NOT NULL DEFAULT true,
    "emailNewNotifications" BOOLEAN NOT NULL DEFAULT true,
    "lastEmailDigestSentAt" TIMESTAMP(3),
    "lastEmailNewNotificationsSentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "NotificationPreferences_updatedAt_idx" ON "NotificationPreferences"("updatedAt");

-- CreateIndex
CREATE INDEX "NotificationPreferences_lastEmailNewNotificationsSentAt_idx" ON "NotificationPreferences"("lastEmailNewNotificationsSentAt");

-- CreateIndex
CREATE INDEX "NotificationPreferences_lastEmailDigestSentAt_idx" ON "NotificationPreferences"("lastEmailDigestSentAt");

-- AddForeignKey
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
