# menofhunger-api

NestJS + Prisma API intended to be consumed by a Next.js app.

## Requirements

- Node.js 20+
- Docker (recommended for local Postgres)

## Setup

### Run Postgres in Docker + API locally (recommended)

1) Copy env template and fill in values:

```bash
cp env.example .env
```

2) Start Postgres:

```bash
docker compose up -d
```

3) Install deps + generate Prisma client:

```bash
npm install
npm run prisma:generate
```

4) Run migrations (dev):

```bash
npm run prisma:migrate
```

5) Start the API:

```bash
npm run dev
```

## Troubleshooting

### Port already in use (3001)

If the API fails to start with `EADDRINUSE` or appears stale:

```bash
npm run dev:check
npm run dev:kill
```

## Endpoints

- `GET /` → `{ ok: true, service: "menofhunger-api" }`
- `GET /health` → `{ ok: true }`
- Swagger UI → `/docs`

## Using from Next.js (local)

In your Next.js app, set:

- `NEXT_PUBLIC_API_URL=http://localhost:3001`

Then call:

- `${process.env.NEXT_PUBLIC_API_URL}/health`

## Production env checklist

Before deploying, ensure these are set (API also validates at startup):

- `NODE_ENV=production`
- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string (BullMQ background jobs)
- `SESSION_HMAC_SECRET` — must be set and not the dev default
- `OTP_HMAC_SECRET` — must be set and not the dev default
- `TRUST_PROXY=true` when behind Render/Cloudflare
- `ALLOWED_ORIGINS` — comma-separated origins (e.g. `https://menofhunger.com`)
- Optionally: `COOKIE_DOMAIN`, `REQUIRE_CSRF_ORIGIN_IN_PROD=true`

To check required env without starting the server: `node scripts/check-env.mjs` (load `.env` first or set vars in the shell).

## Background jobs / workers

This API uses a Redis-backed queue (BullMQ) for background work. In the simplest setup, the API process both enqueues and consumes jobs.

### Role flags

You can split responsibilities between an API service and one or more worker services using these env vars:

- `RUN_HTTP` — when false, the process will not bind an HTTP port
- `RUN_SCHEDULERS` — when false, cron schedulers will not enqueue jobs
- `RUN_JOB_CONSUMERS` — when false, BullMQ processors will not consume jobs

Recommended Render split:

- **API service**: `RUN_HTTP=true`, `RUN_SCHEDULERS=true`, `RUN_JOB_CONSUMERS=false`
- **Worker service**: `RUN_HTTP=false`, `RUN_SCHEDULERS=false` (or true on exactly one instance), `RUN_JOB_CONSUMERS=true`
