ALTER TYPE "MarvinSource" ADD VALUE IF NOT EXISTS 'admin_console';
CREATE TABLE "AdminAssistantTurn" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "question" TEXT NOT NULL,
  "answer" TEXT, "status" TEXT NOT NULL DEFAULT 'running', "sources" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "AdminAssistantTurn_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AdminAssistantAction" (
  "id" TEXT NOT NULL, "turnId" TEXT NOT NULL, "operation" TEXT NOT NULL, "targetId" TEXT,
  "title" TEXT NOT NULL, "path" TEXT NOT NULL, "input" JSONB NOT NULL, "before" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "resultMessage" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "AdminAssistantAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAssistantTurn_userId_createdAt_idx" ON "AdminAssistantTurn"("userId", "createdAt" DESC);
CREATE INDEX "AdminAssistantAction_turnId_createdAt_idx" ON "AdminAssistantAction"("turnId", "createdAt");
ALTER TABLE "AdminAssistantTurn" ADD CONSTRAINT "AdminAssistantTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminAssistantAction" ADD CONSTRAINT "AdminAssistantAction_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "AdminAssistantTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
