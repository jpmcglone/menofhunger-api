CREATE TABLE "DelegationRun" ("id" TEXT PRIMARY KEY, "status" TEXT, "jobSnapshot" JSONB, "notifiedAt" TIMESTAMP, "notificationKey" TEXT);
CREATE TABLE "DelegationAction" ("id" TEXT PRIMARY KEY, "runId" TEXT, "operation" TEXT, "status" TEXT, "subjectKey" TEXT, "completedAt" TIMESTAMP, "receipt" TEXT);
INSERT INTO "DelegationRun" ("id", "status", "jobSnapshot") VALUES
 ('historical', 'failed', '{"revision":1}'),
 ('no-opt-in', 'review', '{"schedule":{"frequency":"daily"}}'),
 ('muted', 'complete', '{"schedule":{"notification":"none"}}'),
 ('new-run', 'review', '{"schedule":{"notification":"actionable"}}'),
 ('retired-issue', 'review', '{"revision":1}'),
 ('mixed', 'review', '{"revision":1}');
INSERT INTO "DelegationAction" ("id", "runId", "operation", "status", "subjectKey", "receipt") VALUES
 ('pending-issue', 'retired-issue', 'github_issue', 'pending', 'key1', NULL),
 ('mixed-issue', 'mixed', 'github_issue', 'pending', 'key2', NULL),
 ('other', 'mixed', 'post_publish', 'pending', 'key3', NULL),
 ('uncertain-issue', 'new-run', 'github_issue', 'uncertain', 'key4', 'Check result'),
 ('complete-issue', 'new-run', 'github_issue', 'complete', 'key5', 'Created');
