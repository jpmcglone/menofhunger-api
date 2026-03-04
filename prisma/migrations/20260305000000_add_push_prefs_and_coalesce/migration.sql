-- AlterTable
ALTER TABLE "NotificationPreferences" ADD COLUMN     "pushRepost" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushNudge" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushFollowedPost" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PushCoalesce" (
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushCoalesce_pkey" PRIMARY KEY ("userId","kind")
);

-- CreateIndex
CREATE INDEX "PushCoalesce_userId_kind_idx" ON "PushCoalesce"("userId", "kind");

-- AddForeignKey
ALTER TABLE "PushCoalesce" ADD CONSTRAINT "PushCoalesce_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
