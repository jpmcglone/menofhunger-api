DO $$ BEGIN
 IF (SELECT COUNT(*) FROM "DelegationRun" WHERE "id" <> 'new-run' AND "notifiedAt" IS NOT NULL) <> 5 THEN RAISE EXCEPTION 'Historical notifications were not retired'; END IF;
 IF (SELECT "notifiedAt" FROM "DelegationRun" WHERE "id" = 'new-run') IS NOT NULL THEN RAISE EXCEPTION 'New opted-in delivery was suppressed'; END IF;
 IF (SELECT COUNT(*) FROM "DelegationAction" WHERE "operation" = 'github_issue' AND "status" = 'pending') <> 0 THEN RAISE EXCEPTION 'Pending GitHub proposals survived'; END IF;
 IF (SELECT "subjectKey" FROM "DelegationAction" WHERE "id" = 'pending-issue') IS NOT NULL THEN RAISE EXCEPTION 'Cancelled proposal retained reservation'; END IF;
 IF (SELECT "status" FROM "DelegationAction" WHERE "id" = 'other') <> 'pending' THEN RAISE EXCEPTION 'Unrelated action changed'; END IF;
 IF (SELECT "receipt" FROM "DelegationAction" WHERE "id" = 'uncertain-issue') <> 'Check result' THEN RAISE EXCEPTION 'Uncertain receipt changed'; END IF;
 IF (SELECT "receipt" FROM "DelegationAction" WHERE "id" = 'complete-issue') <> 'Created' THEN RAISE EXCEPTION 'Completed receipt changed'; END IF;
 IF (SELECT "status" FROM "DelegationRun" WHERE "id" = 'mixed') <> 'review' THEN RAISE EXCEPTION 'Mixed run no longer reviewable'; END IF;
 IF (SELECT "notificationKey" FROM "DelegationRun" WHERE "id" = 'retired-issue') <> 'retired-issue-complete' THEN RAISE EXCEPTION 'Retired run can replay under the old worker'; END IF;
END $$;
