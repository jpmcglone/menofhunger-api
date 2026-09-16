#!/usr/bin/env bash
# Always creates and destroys its own synthetic database; never uses DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
container=$(docker run --rm --detach -e POSTGRES_PASSWORD=synthetic-fixture \
  -e POSTGRES_DB=moh_erasure_fixture -p 127.0.0.1::5432 postgres:16)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -U postgres -d moh_erasure_fixture >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(docker port "$container" 5432/tcp | sed 's/127.0.0.1://')
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Could not resolve fixture port' >&2; exit 1; }
export DATABASE_URL="postgresql://postgres:synthetic-fixture@127.0.0.1:${port}/moh_erasure_fixture"
export MOH_ERASURE_FIXTURE_DATABASE_URL="$DATABASE_URL"
# Historical migrations predate the full schema. Start from a pinned schema,
# record its exact migration checksums, then run every newer migration normally.
node scripts/prepare-database-baseline.mjs
node_modules/.bin/prisma db push --schema test/database-baseline/schema.prisma --skip-generate
baseline_sql=$(mktemp)
trap 'rm -f "$baseline_sql"; docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
node scripts/prepare-database-baseline.mjs --sql > "$baseline_sql"
node_modules/.bin/prisma db execute --url "$DATABASE_URL" --file "$baseline_sql"
node_modules/.bin/prisma migrate deploy
node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
node_modules/.bin/jest --runInBand --runTestsByPath src/modules/auth/account-erasure.integration.spec.ts
REGRESSION_DATABASE_URL="$DATABASE_URL" node_modules/.bin/jest --runInBand --config test/jest-e2e.json --runTestsByPath test/coin-and-chat-regressions.e2e-spec.ts
docker exec "$container" createdb -U postgres moh_ranking_fixture
RUN_POST_RANKING_SQL_TESTS=1 POST_RANKING_FIXTURE_CONTAINER="$container" node_modules/.bin/jest --runInBand --runTestsByPath src/modules/posts/posts-ranking.postgres.spec.ts
