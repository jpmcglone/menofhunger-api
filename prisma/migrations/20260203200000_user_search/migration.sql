-- CreateTable
CREATE TABLE "UserSearch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query" VARCHAR(200) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserSearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserSearch_userId_createdAt_idx" ON "UserSearch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserSearch_createdAt_idx" ON "UserSearch"("createdAt");

-- CreateIndex
CREATE INDEX "UserSearch_query_idx" ON "UserSearch"("query");

-- AddForeignKey
ALTER TABLE "UserSearch" ADD CONSTRAINT "UserSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
