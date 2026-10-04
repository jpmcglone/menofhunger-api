INSERT INTO "Post" VALUES ('post'), ('other');
INSERT INTO "PostView" VALUES ('post', 'owner', 1, '2026-10-04 15:00:00');
UPDATE "PostView" SET "lastImpressionAt" = '2026-10-04 15:00:05' WHERE "userId" = 'owner';
DO $$ BEGIN
  IF (SELECT SUM("impressions") FROM "PostReachDay") <> 1 THEN RAISE EXCEPTION 'No-op refresh counted'; END IF;
END $$;
UPDATE "PostView" SET "impressionCount" = 2, "lastImpressionAt" = '2026-10-04 15:01:00' WHERE "userId" = 'owner';
INSERT INTO "PostAnonView" VALUES ('post', 'guest', 1, '2026-10-05 03:59:59');
UPDATE "PostAnonView" SET "impressionCount" = 2, "lastImpressionAt" = '2026-10-05 04:00:00' WHERE "anonId" = 'guest';
DELETE FROM "PostAnonView" WHERE "anonId" = 'guest';
INSERT INTO "PostView" VALUES ('post', 'signed-in-guest', 1, '2026-10-05 04:01:00');
DO $$ BEGIN
  IF (SELECT SUM("impressions") FROM "PostReachDay" WHERE "day" = '2026-10-04') <> 3 THEN RAISE EXCEPTION 'Eastern boundary or repeat count wrong'; END IF;
  IF (SELECT SUM("impressions") FROM "PostReachDay" WHERE "day" = '2026-10-05') <> 2 THEN RAISE EXCEPTION 'Next Eastern day wrong'; END IF;
  IF (SELECT SUM("impressions") FROM "PostReachDay" WHERE "anonId" = 'guest') <> 2 THEN RAISE EXCEPTION 'Sign-in erased history'; END IF;
END $$;
BEGIN;
UPDATE "PostView" SET "impressionCount" = 3 WHERE "userId" = 'owner';
ROLLBACK;
DO $$ BEGIN
  IF (SELECT SUM("impressions") FROM "PostReachDay" WHERE "userId" = 'owner') <> 2 THEN RAISE EXCEPTION 'Rollback leaked counts'; END IF;
END $$;
-- Both sides of fall-back stay on the same Eastern date.
INSERT INTO "PostView" VALUES ('other', 'reader', 1, '2026-11-01 05:30:00');
UPDATE "PostView" SET "impressionCount" = 2, "lastImpressionAt" = '2026-11-01 06:30:00' WHERE "postId" = 'other';
DO $$ BEGIN
  IF (SELECT SUM("impressions") FROM "PostReachDay" WHERE "postId" = 'other' AND "day" = '2026-11-01') <> 2 THEN RAISE EXCEPTION 'DST bucket wrong'; END IF;
END $$;
DELETE FROM "Post" WHERE "id" = 'post';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM "PostReachDay" WHERE "postId" = 'post') THEN RAISE EXCEPTION 'Post deletion left reach history'; END IF;
  IF NOT EXISTS(SELECT 1 FROM "PostReachTracking" WHERE "id" = 'posts') THEN RAISE EXCEPTION 'Tracking coverage missing'; END IF;
END $$;
SELECT 'PASS: accepted counts, no-op, Eastern midnight, DST, sign-in, rollback, deletion, coverage' AS result;

INSERT INTO "PostAnonView" VALUES ('other', 'linked-guest', 1, '2026-11-01 06:30:00');
INSERT INTO "ViewerIdentity" VALUES ('linked-guest', 'reader');
DELETE FROM "User" WHERE "id" = 'reader';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM "PostReachDay" WHERE "userId" = 'reader' OR "anonId" = 'linked-guest') THEN RAISE EXCEPTION 'Account erasure retained attribution'; END IF;
END $$;
SELECT 'PASS: account erasure cascades authenticated and linked anonymous attribution' AS result;
