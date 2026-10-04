#!/usr/bin/env bash
# Isolated synthetic PostgreSQL only; never reads DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
container=$(docker run --rm --detach -e POSTGRES_PASSWORD=synthetic-fixture postgres:16)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
for sql in test/post-reach/fixture.sql prisma/migrations/20261004203000_post_window_reach/migration.sql test/post-reach/assertions.sql; do
  docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 < "$sql"
done
