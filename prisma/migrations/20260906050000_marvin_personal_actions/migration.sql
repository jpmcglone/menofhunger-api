-- CreateTable
CREATE TABLE "MarvinPersonalAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "receipt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarvinPersonalAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarvinPersonalAction_requestKey_key" ON "MarvinPersonalAction"("requestKey");

-- CreateIndex
CREATE INDEX "MarvinPersonalAction_userId_createdAt_idx" ON "MarvinPersonalAction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "MarvinPersonalAction" ADD CONSTRAINT "MarvinPersonalAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

