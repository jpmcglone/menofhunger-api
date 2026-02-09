-- CreateTable
CREATE TABLE "TopicFollow" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "topic" VARCHAR(64) NOT NULL,

    CONSTRAINT "TopicFollow_pkey" PRIMARY KEY ("userId","topic")
);

-- CreateIndex
CREATE INDEX "TopicFollow_userId_createdAt_idx" ON "TopicFollow"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TopicFollow_topic_createdAt_idx" ON "TopicFollow"("topic", "createdAt");

-- AddForeignKey
ALTER TABLE "TopicFollow" ADD CONSTRAINT "TopicFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
