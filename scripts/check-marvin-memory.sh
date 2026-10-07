#!/usr/bin/env bash
# Exercise the actual additive migration against synthetic source tables only.
# Never reads DATABASE_URL or touches an existing database/container.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture_container=$(docker run --rm --detach -e POSTGRES_PASSWORD=synthetic-fixture \
  -e POSTGRES_DB=moh_memory_fixture pgvector/pgvector:pg16)
trap 'docker rm -f "$fixture_container" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$fixture_container" pg_isready -h 127.0.0.1 -U postgres -d moh_memory_fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_fixture() { docker exec -i "$fixture_container" psql -U postgres -d moh_memory_fixture -v ON_ERROR_STOP=1; }
psql_fixture <<'SQL'
CREATE TABLE "Post" (id TEXT PRIMARY KEY);
CREATE TABLE "Message" (id TEXT PRIMARY KEY);
INSERT INTO "Post" VALUES ('post-a'), ('post-b');
INSERT INTO "Message" VALUES ('message-a');
SQL
psql_fixture < prisma/migrations/20260928140000_marvin_scoped_memory/migration.sql
psql_fixture <<'SQL'
INSERT INTO "MarvinMemorySource" (id, "scopeKey", "postId", "learnedAt")
VALUES ('memory-a', 'public', 'post-a', '2026-01-01');
INSERT INTO "MarvinMemorySource" (id, "scopeKey", "messageId")
VALUES ('memory-b', 'conversation:dm-a', 'message-a');
-- Matches Prisma createMany(skipDuplicates): neither scope nor learned time changes.
INSERT INTO "MarvinMemorySource" (id, "scopeKey", "postId")
VALUES ('new-observation', 'group:other', 'post-a') ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF (SELECT "learnedAt" <> TIMESTAMP '2026-01-01' OR "scopeKey" <> 'public'
      FROM "MarvinMemorySource" WHERE id = 'memory-a') THEN
    RAISE EXCEPTION 'Observation changed original scope or learned time';
  END IF;
  BEGIN
    INSERT INTO "MarvinMemorySource" (id, "scopeKey") VALUES ('invalid', 'public');
    RAISE EXCEPTION 'Accepted a memory with no source';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO "MarvinMemorySource" (id, "scopeKey", "postId", "messageId")
    VALUES ('invalid', 'public', 'post-b', 'message-a');
    RAISE EXCEPTION 'Accepted two sources';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO "MarvinMemorySource" (id, "scopeKey", "messageId")
    VALUES ('invalid', 'public', 'message-a');
    RAISE EXCEPTION 'Accepted a public private-message source';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO "MarvinMemorySource" (id, "scopeKey", "postId")
    VALUES ('invalid', 'conversation:dm-a', 'post-b');
    RAISE EXCEPTION 'Accepted a conversation-scoped post';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO "MarvinMemorySource" (id, "scopeKey", "postId")
    VALUES ('invalid', 'public', 'missing');
    RAISE EXCEPTION 'Accepted a dangling source';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
DELETE FROM "Post" WHERE id = 'post-a';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "MarvinMemorySource" WHERE id = 'memory-a') OR
     NOT EXISTS (SELECT 1 FROM "MarvinMemorySource" WHERE id = 'memory-b') THEN
    RAISE EXCEPTION 'Post cascade removed the wrong memory';
  END IF;
END $$;
DELETE FROM "Message" WHERE id = 'message-a';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "MarvinMemorySource") THEN
    RAISE EXCEPTION 'Message cascade left stale memory';
  END IF;
END $$;
SQL
echo 'Marv memory migration: constraints, deduplication, learned time, and cascades passed.'
