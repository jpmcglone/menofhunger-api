BEGIN;
-- CreateTable
CREATE TABLE "DelegationJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'review',
    "schedule" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "jobSnapshot" JSONB NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DelegationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationAction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "before" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "receipt" TEXT,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DelegationAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DelegationJob_ownerId_createdAt_idx" ON "DelegationJob"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DelegationJob_status_nextRunAt_idx" ON "DelegationJob"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "DelegationRun_requestKey_key" ON "DelegationRun"("requestKey");

-- CreateIndex
CREATE INDEX "DelegationRun_jobId_createdAt_idx" ON "DelegationRun"("jobId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "DelegationRun_status_createdAt_idx" ON "DelegationRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DelegationAction_runId_createdAt_idx" ON "DelegationAction"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "DelegationJob" ADD CONSTRAINT "DelegationJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationJob" ADD CONSTRAINT "DelegationJob_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationRun" ADD CONSTRAINT "DelegationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "DelegationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationAction" ADD CONSTRAINT "DelegationAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DelegationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A job has at most one queued/running execution, including competing API instances.
CREATE UNIQUE INDEX "DelegationRun_one_active_per_job" ON "DelegationRun"("jobId") WHERE "status" IN ('queued', 'running');

COMMIT;
