#!/usr/bin/env bash
# Isolated synthetic fixture; never connects to DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
container=$(docker run --rm --detach -e POSTGRES_PASSWORD=synthetic-fixture -e POSTGRES_DB=moh_call_budget -p 127.0.0.1::5432 postgres:16)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -U postgres -d moh_call_budget >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(docker port "$container" 5432/tcp | sed 's/127.0.0.1://')
[[ "$port" =~ ^[0-9]+$ ]]
export CALL_BUDGET_FIXTURE_DATABASE_URL="postgresql://postgres:synthetic-fixture@127.0.0.1:${port}/moh_call_budget"
docker exec -i "$container" psql -U postgres -d moh_call_budget -v ON_ERROR_STOP=1 < prisma/migrations/20261002140000_call_budget/migration.sql
node_modules/.bin/jest --runInBand --runTestsByPath src/modules/calls/call-budget.postgres.spec.ts
