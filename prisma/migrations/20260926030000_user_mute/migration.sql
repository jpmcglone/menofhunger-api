-- CreateTable
CREATE TABLE "UserMute" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muterId" TEXT NOT NULL,
    "mutedId" TEXT NOT NULL,

    CONSTRAINT "UserMute_pkey" PRIMARY KEY ("muterId","mutedId")
);

-- CreateIndex
CREATE INDEX "UserMute_mutedId_idx" ON "UserMute"("mutedId");

-- AddForeignKey
ALTER TABLE "UserMute" ADD CONSTRAINT "UserMute_muterId_fkey" FOREIGN KEY ("muterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMute" ADD CONSTRAINT "UserMute_mutedId_fkey" FOREIGN KEY ("mutedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
