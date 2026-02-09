-- CreateTable
CREATE TABLE "UserDailyActivity" (
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDailyActivity_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE INDEX "UserDailyActivity_day_idx" ON "UserDailyActivity"("day");

-- AddForeignKey
ALTER TABLE "UserDailyActivity" ADD CONSTRAINT "UserDailyActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
