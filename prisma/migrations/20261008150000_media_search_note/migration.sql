-- CreateTable
CREATE TABLE "MediaSearchNote" (
    "r2Key" TEXT NOT NULL,
    "note" VARCHAR(200) NOT NULL,
    "postId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaSearchNote_pkey" PRIMARY KEY ("r2Key")
);

-- CreateIndex
CREATE INDEX "MediaSearchNote_postId_idx" ON "MediaSearchNote"("postId");
