#!/usr/bin/env bash
# Synthetic PostgreSQL only. Never reads DATABASE_URL or production credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
container=$(docker run --rm --detach -e POSTGRES_PASSWORD=synthetic-fixture -e POSTGRES_DB=moh_delegation_fixture pgvector/pgvector:pg16)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -U postgres -d moh_delegation_fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
migration=prisma/migrations/20261004173000_delegation_notification_opt_in/migration.sql
cat test/delegation-rollout/setup.sql "$migration" test/delegation-rollout/assert.sql "$migration" test/delegation-rollout/assert.sql | docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d moh_delegation_fixture
