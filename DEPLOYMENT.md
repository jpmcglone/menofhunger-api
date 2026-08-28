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
