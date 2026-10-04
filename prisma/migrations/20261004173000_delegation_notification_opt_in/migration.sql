-- The initial rollout left every historical run undelivered. Retire that backlog
-- without sending alerts, including side-effect messages already queued by old workers.
UPDATE "DelegationRun"
SET "notifiedAt" = CURRENT_TIMESTAMP,
    "notificationKey" = "id" || '-' || "status"
WHERE "status" IN ('review', 'failed', 'uncertain', 'complete')
  AND "notifiedAt" IS NULL
  AND COALESCE("jobSnapshot" #>> '{schedule,notification}', 'none')
      NOT IN ('actionable', 'all', 'digest');

-- Remove unexecuted GitHub proposals without erasing completed/uncertain receipts.
UPDATE "DelegationAction"
SET "status" = 'cancelled', "subjectKey" = NULL,
    "completedAt" = CURRENT_TIMESTAMP,
    "receipt" = 'GitHub issue creation was removed. Issue tracking uses Linear.'
WHERE "operation" = 'github_issue' AND "status" = 'pending';

UPDATE "DelegationRun" AS run
SET "status" = 'complete',
    "notificationKey" = CASE WHEN run."notifiedAt" IS NOT NULL
      THEN run."id" || '-complete' ELSE run."notificationKey" END
WHERE run."status" = 'review'
  AND EXISTS (SELECT 1 FROM "DelegationAction" AS action
              WHERE action."runId" = run."id" AND action."operation" = 'github_issue')
  AND NOT EXISTS (SELECT 1 FROM "DelegationAction" AS action
                  WHERE action."runId" = run."id"
                  AND action."status" NOT IN ('cancelled', 'complete'));
