-- CreateTable
CREATE TABLE "PostPoll" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "totalVoteCount" INTEGER NOT NULL DEFAULT 0,
    "postId" TEXT NOT NULL,

    CONSTRAINT "PostPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostPollOption" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pollId" TEXT NOT NULL,
    "text" VARCHAR(30) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "imageR2Key" TEXT,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "imageAlt" VARCHAR(500),
    "voteCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PostPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostPollVote" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pollId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "PostPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostPoll_postId_key" ON "PostPoll"("postId");

-- CreateIndex
CREATE INDEX "PostPoll_endsAt_idx" ON "PostPoll"("endsAt");

-- CreateIndex
CREATE INDEX "PostPoll_createdAt_idx" ON "PostPoll"("createdAt");

-- CreateIndex
CREATE INDEX "PostPollOption_pollId_position_idx" ON "PostPollOption"("pollId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PostPollOption_pollId_position_key" ON "PostPollOption"("pollId", "position");

-- CreateIndex
CREATE INDEX "PostPollVote_pollId_createdAt_idx" ON "PostPollVote"("pollId", "createdAt");

-- CreateIndex
CREATE INDEX "PostPollVote_optionId_createdAt_idx" ON "PostPollVote"("optionId", "createdAt");

-- CreateIndex
CREATE INDEX "PostPollVote_userId_createdAt_idx" ON "PostPollVote"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostPollVote_pollId_userId_key" ON "PostPollVote"("pollId", "userId");

-- AddForeignKey
ALTER TABLE "PostPoll" ADD CONSTRAINT "PostPoll_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostPollOption" ADD CONSTRAINT "PostPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PostPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostPollVote" ADD CONSTRAINT "PostPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "PostPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostPollVote" ADD CONSTRAINT "PostPollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PostPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostPollVote" ADD CONSTRAINT "PostPollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
