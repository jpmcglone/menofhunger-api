# Deployment

## Render

The existing dashboard-managed API uses Render's native Node runtime. This repository
also supports Docker (`Dockerfile`); `render.yaml` describes that alternative and does
not establish the existing service's runtime. Production health lives at the
unversioned root: `GET /health` (not `/v1/health`).

For native Node, use `npm ci && npm run build` as the build command and `npm run start`
as the start command, preserving the existing pre-deploy migration command. The root
postinstall generates Prisma and installs the shared MCP package from its own lockfile.
Do not disable install lifecycle scripts without explicitly running `npm run postinstall`.
Both runtimes need Node 20.19+. Startup failures exit immediately instead of leaving
background Redis connections alive while Render waits for an HTTP port.

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
releasing a schema-dependent API build. Render recommends this stage for migrations
([pre-deploy documentation](https://render.com/docs/deploys#pre-deploy-command)).
If a different migration command is already
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

## Runtime memory and image uploads

Production logs include a `runtime_memory` sample at startup and every minute:
RSS, JavaScript heap used/total, external memory, ArrayBuffers, V8 heap limit,
container limit when Node can detect it, and process uptime. RSS includes native
allocations; `external`/`arrayBuffers` do not account for every libvips allocation.
Compare these logs with Render's memory graph and instance restart events. A short
spike may fall between samples; absence of a sampled peak does not rule it out.

Clients prepare photos before upload. The API reads image metadata but **does not
rotate, resize, or rewrite upright JPEGs**, including large upright images. For
legacy JPEGs whose EXIF orientation still needs correction, it normalizes one image
at a time, rejects inputs over 64 megapixels before decoding, and fits large rotated
outputs within 3840 pixels. At most eight requests wait, without downloading their
image bytes, for up to 15 seconds. Busy responses use retryable HTTP 503 and retain
the uploaded object. PNG/WebP/GIF bytes are not re-encoded by this fallback.

The September 7, 2026 incident was confirmed in Render at 1:43:46pm ET: the API
exceeded its 512 MB limit. Its preceding 12-hour graph was broadly steady near
65–70%, with roughly 80% usage after restarting. This supports an acute spike and
limited capacity, but does not establish the triggering request or prove the absence
of another leak. A local synthetic 48MP rotated JPEG reproduced a substantial image
memory spike. Keep production attribution separate from that isolated benchmark.

For this combined HTTP/realtime/job-worker process, recommend the 1 CPU / 2 GB
compute plan (`1c-2g`, formerly Standard) for operating headroom. The live service is
dashboard-managed: a Blueprint edit alone will not upgrade it. Verify the current
price in Render before changing billing. Apply API changes before web changes, then
inspect runtime memory under normal traffic and image uploads.

## Database concurrency budget (September 8, 2026)

The current small database must have an explicit per-process connection budget.
`PrismaService` defaults to `connection_limit=5` and `pool_timeout=10` when absent;
valid positive URL overrides are preserved. Count every API replica, separate worker,
and overlapping deploy instance when setting the total budget. A CPU-derived Prisma
pool default does not represent the database's memory capacity.

Production configuration applied September 8 without changing any paid plans:

- API `DATABASE_URL`: `connection_limit=20` → `connection_limit=5`.
- `SIDE_EFFECTS_QUEUE_CONCURRENCY=2` and `MARV_QUEUE_CONCURRENCY=2` (previous defaults 12 and 8).
- `PRISMA_LOG_SLOW_QUERIES=true`, `PRISMA_SLOW_QUERY_MS=500`. Existing logs contain
  duration, SQL kind, and a fingerprint, never query parameters.
- Shared Valkey: `maxmemory-policy=noeviction`. Existing AOF persistence was verified
  enabled and healthy. Queue data must not compete with caches under an eviction policy.
  Cache writes can fail at capacity; inspect usage and errors before changing limits.

The configuration rollout reused deployed commit `79c646d` and completed successfully
(`dep-dag1ai9t0dsc73870470`). At 10:10 EDT, runtime inspection showed five idle app
connections (previously twenty), one temporary diagnostic connection, and healthy
DB/Redis responses of 2 ms/1 ms. At 10:12 EDT all three queues had workers and zero
waiting, active, delayed, or failed jobs. These are snapshots, not a long-term SLA.

The prior 24-hour DB logs showed nine backend SIGKILL events followed by cluster
reinitialization/recovery. Killed statements varied, including ordinary indexed post
lookups. Recovery explains the “not yet accepting connections” errors; those errors
are consequences, not evidence of a broken session query. The 256 MB instance had
64 MB shared buffers, ~1.6 MB work_mem per operation, hash multiplier 2, and up to
three 16 MB autovacuum workers. Twenty backends and concurrent workers added avoidable
memory pressure. Disk usage was only ~0.19 GB of 15 GB. A sampled post lookup used
its primary-key index. Feed candidate queries are bounded, but contain concurrent
lanes and enrichment queries; they share the same pool budget.

Memory exhaustion is the leading explanation for the kills, but dashboard memory
includes cache and kernel OOM records were unavailable. `pg_stat_statements` was not
installed; backend memory introspection was denied. No speculative index, work_mem,
JIT, or database-wide configuration changes were made. Capture the next failing
query fingerprint, pool wait errors, queue backlog, and Render restart event before
attributing residual failures to a specific query. If SIGKILL repeats with this budget,
obtain host OOM evidence from Render and reassess the 256 MB capacity. Increasing a
paid tier requires the owner's action; never purchase or resize on their behalf.

Rollback configuration through the same environment page using the existing build.
Prefer correcting a demonstrated throughput problem incrementally over restoring
20 connections blindly. Keep `noeviction` while BullMQ shares this Redis instance.
