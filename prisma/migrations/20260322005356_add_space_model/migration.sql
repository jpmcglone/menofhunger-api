-- CreateEnum
CREATE TYPE "SpaceMode" AS ENUM ('NONE', 'WATCH_PARTY', 'RADIO');

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "mode" "SpaceMode" NOT NULL DEFAULT 'NONE',
    "watchPartyUrl" VARCHAR(2000),
    "radioStreamUrl" VARCHAR(2000),

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Space_ownerId_key" ON "Space"("ownerId");

-- CreateIndex
CREATE INDEX "Space_isActive_idx" ON "Space"("isActive");

-- AddForeignKey
ALTER TABLE "Space" ADD CONSTRAINT "Space_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
