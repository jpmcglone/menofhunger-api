-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "AnnouncementPlatform" AS ENUM ('web', 'ios');

-- CreateEnum
CREATE TYPE "AnnouncementEventType" AS ENUM ('presented', 'viewed', 'dismissed', 'clicked', 'abandoned');

-- CreateEnum
CREATE TYPE "AnnouncementDismissMethod" AS ENUM ('close_button', 'backdrop', 'escape', 'swipe');

-- CreateEnum
CREATE TYPE "AnnouncementOutcome" AS ENUM ('presented', 'viewed', 'dismissed', 'clicked', 'abandoned');

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isAd" BOOLEAN NOT NULL DEFAULT false,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "imageKey" TEXT,
    "imageUpdatedAt" TIMESTAMP(3),
    "ctaLabel" TEXT,
    "ctaHref" TEXT,
    "maxViews" INTEGER NOT NULL DEFAULT 1,
    "endsAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementAudience" (
    "viewerKey" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementAudience_pkey" PRIMARY KEY ("viewerKey")
);

-- CreateTable
CREATE TABLE "AnnouncementViewer" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "userId" TEXT,
    "anonymousId" TEXT,
    "platform" "AnnouncementPlatform" NOT NULL,
    "presentCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "abandonedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "lastPresentedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "lastOutcome" "AnnouncementOutcome",
    "lastDismissMethod" "AnnouncementDismissMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementViewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementEvent" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "viewerKey" TEXT NOT NULL,
    "platform" "AnnouncementPlatform" NOT NULL,
    "type" "AnnouncementEventType" NOT NULL,
    "dismissMethod" "AnnouncementDismissMethod",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_status_isAd_publishedAt_idx" ON "Announcement"("status", "isAd", "publishedAt");

-- CreateIndex
CREATE INDEX "Announcement_status_endsAt_idx" ON "Announcement"("status", "endsAt");

-- CreateIndex
CREATE INDEX "AnnouncementAudience_userId_idx" ON "AnnouncementAudience"("userId");

-- CreateIndex
CREATE INDEX "AnnouncementAudience_anonymousId_idx" ON "AnnouncementAudience"("anonymousId");

-- CreateIndex
CREATE INDEX "AnnouncementViewer_viewerKey_platform_idx" ON "AnnouncementViewer"("viewerKey", "platform");

-- CreateIndex
CREATE INDEX "AnnouncementViewer_announcementId_idx" ON "AnnouncementViewer"("announcementId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementViewer_announcementId_viewerKey_platform_key" ON "AnnouncementViewer"("announcementId", "viewerKey", "platform");

-- CreateIndex
CREATE INDEX "AnnouncementEvent_announcementId_type_idx" ON "AnnouncementEvent"("announcementId", "type");

-- CreateIndex
CREATE INDEX "AnnouncementEvent_viewerKey_platform_createdAt_idx" ON "AnnouncementEvent"("viewerKey", "platform", "createdAt");

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementAudience" ADD CONSTRAINT "AnnouncementAudience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementViewer" ADD CONSTRAINT "AnnouncementViewer_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementViewer" ADD CONSTRAINT "AnnouncementViewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementEvent" ADD CONSTRAINT "AnnouncementEvent_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
