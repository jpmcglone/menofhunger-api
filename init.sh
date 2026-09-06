#!/usr/bin/env bash
# Local developer setup. Run from any directory; existing configuration is preserved.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SETUP_ONLY=false
case "${1:-}" in
  --setup-only) SETUP_ONLY=true ;;
  --help|-h)
    printf 'Usage: ./init.sh [--setup-only]\nSet up local development; --setup-only skips launching the app.\n'
    exit 0 ;;
  '') ;;
  *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then
  printf 'Expected at most one argument. Run ./init.sh --help.\n' >&2
  exit 1
fi
require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing %s. %s\n' "$1" "$2" >&2
    exit 1
  fi
}

require node "Install Node $(cat .nvmrc), then rerun ./init.sh."
require npm 'Install npm with Node, then rerun ./init.sh.'
node <<'NODE'
const fs = require('node:fs');
const required = fs.readFileSync('.nvmrc', 'utf8').trim().split('.').map(Number);
const actual = process.versions.node.split('.').map(Number);
const difference = actual.map((v, i) => v - required[i]).find(v => v !== 0) || 0;
if (difference < 0) {
  console.error(`Node ${required.join('.')} or newer is required; found ${process.versions.node}.`);
  process.exit(1);
}
NODE

require docker 'Install and start Docker with Compose, then rerun ./init.sh.'
docker compose version >/dev/null
docker info >/dev/null
if [ ! -f .env ]; then
  cp env.example .env
  printf '\n# Local init: suppress real SMS during development.\nDISABLE_TWILIO_IN_DEV=true\n' >> .env
  printf 'Created .env from env.example.\n'
fi

# Parse environment data without evaluating it as shell code. Inherited environment
# values take precedence, matching the app; refuse remote databases and production.
node --env-file=.env <<'NODE'
function stop(message) { console.error(message); process.exit(1); }
if (process.env.NODE_ENV !== 'development') stop('Set NODE_ENV=development for local initialization.');
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  let url;
  try { url = new URL(process.env[name]); } catch { stop(`${name} must be a valid local URL.`); }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    stop(`${name} points outside localhost. Local init will not operate on it.`);
  }
}
NODE

printf 'Starting local Postgres and Redis…\n'
docker compose up -d --wait db redis
printf 'Installing locked dependencies and generating Prisma client…\n'
npm ci
printf 'Applying committed migrations to the local database…\n'
# Deliberately use Prisma directly: the deployment wrapper also performs backfills.
npx prisma migrate deploy
printf '\nAPI setup complete. Local login code: 000000.\n'
if [ "$SETUP_ONLY" = true ]; then
  printf 'Start with: DISABLE_TWILIO_IN_DEV=true npm run dev\n'
  exit 0
fi
# Avoid killing or replacing an existing server. The app will report any bind error.
printf 'Starting the API (Ctrl-C stops it; Docker dependencies remain running).\n'
export DISABLE_TWILIO_IN_DEV=true
exec npm run dev
