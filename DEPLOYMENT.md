# Deployment

## Render

The API is a Docker web service (`Dockerfile`). Production health lives at the unversioned root: `GET /health` (not `/v1/health`).

### Zero-downtime deploys

Render boots the new instance beside the live one and only flips traffic after `GET /health` returns 2xx. That endpoint checks Postgres and Redis and returns **503** if either is down, so a half-booted instance never takes traffic.

`enableShutdownHooks()` in `src/main.ts` drains the Nest process on `SIGTERM`. `maxShutdownDelaySeconds: 120` (see `render.yaml`) gives in-flight HTTP and socket work time to finish.

- **Do not attach a persistent disk.** That disables zero-downtime and forces a hard cutover.
- Stagger deploys when both repos change: ship the API first, wait until it is live, then www.
- Live sockets reconnect when the old process exits. That is not HTTP downtime.

### Dashboard (required if this service is not Blueprint-managed)

On the API web service → **Settings**:

1. **Health Check Path** = `/health`
2. **Max Shutdown Delay** = `120` seconds
3. Confirm **no persistent disk** is attached

Do not create a second service from `render.yaml` unless you intend to migrate onto a Blueprint.

## Database migrations and release order

The Docker image includes Prisma and committed migrations, but its startup command
only starts the API. Confirm the existing Render service's **Pre-Deploy Command**
runs `npx prisma migrate deploy` against the intended production database before
releasing a schema-dependent API build. If a different migration command is already
configured, review it before replacing it. Dashboard-managed settings are not
proven by this repository's `render.yaml`.

The `npm run prisma:migrate:deploy` wrapper also runs historical repairs and backfills;
it requires `scripts/`, which the current runtime image does not copy. Do not use
that wrapper as a Docker pre-deploy command without deliberately packaging and
reviewing those additional operations.

For the conversation-insights release:

1. Confirm the intended commit includes
   `prisma/migrations/20260905160000_conversation_coin_attribution/migration.sql`.
   It adds nullable `CoinTransfer.postId`, an index, and an `ON DELETE SET NULL`
   foreign key; existing transfers remain valid without attribution.
2. Run the approved migration step before the new API takes traffic. Verify that
   migration finished successfully in `_prisma_migrations` on the target database.
3. Deploy the API and wait for `/health` to pass. Database connectivity alone does
   not prove the migration ran; check the migration result separately.
4. Deploy www, then distribute the iOS build. Smoke-test posting, chat, and insights
   against the released API.

If application rollback is needed, keep the additive nullable schema in place; do
not drop attribution data as part of rolling back application code. Production
migrations are a deployment action, not an implicit local validation step.
