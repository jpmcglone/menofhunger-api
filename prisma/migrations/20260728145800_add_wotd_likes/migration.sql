-- CreateTable
CREATE TABLE "WotdLike" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WotdLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WotdLike_word_idx" ON "WotdLike"("word");

-- CreateIndex
CREATE INDEX "WotdLike_userId_idx" ON "WotdLike"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WotdLike_word_userId_key" ON "WotdLike"("word", "userId");

-- AddForeignKey
ALTER TABLE "WotdLike" ADD CONSTRAINT "WotdLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
