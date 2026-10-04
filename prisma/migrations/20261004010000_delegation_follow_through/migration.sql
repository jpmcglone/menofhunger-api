ALTER TABLE "DelegationJob" ADD COLUMN "baseline" JSONB, ADD COLUMN "resumeAt" TIMESTAMP(3);
ALTER TABLE "DelegationRun" ADD COLUMN "notificationKey" TEXT, ADD COLUMN "notifiedAt" TIMESTAMP(3);
ALTER TABLE "Notification" ADD COLUMN "actionPath" TEXT;
ALTER TABLE "DelegationAction" ADD COLUMN "subjectKey" TEXT;
CREATE UNIQUE INDEX "DelegationAction_subjectKey_key" ON "DelegationAction"("subjectKey");
