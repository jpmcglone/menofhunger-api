-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('comment', 'boost', 'follow', 'mention', 'generic');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "recipientUserId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "actorUserId" TEXT,
    "subjectPostId" TEXT,
    "subjectUserId" TEXT,
    "title" TEXT,
    "body" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt" DESC);
CREATE INDEX "Notification_recipientUserId_deliveredAt_idx" ON "Notification"("recipientUserId", "deliveredAt");
CREATE INDEX "Notification_recipientUserId_readAt_idx" ON "Notification"("recipientUserId", "readAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectPostId_fkey" FOREIGN KEY ("subjectPostId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
