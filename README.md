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

## Endpoints & Documentation

A small set of operational endpoints live at the document root for stability (load balancers, Stripe dashboard, Apple universal links, etc.). This list is the single source of truth and is defined as the `UNVERSIONED_ROOT_PATHS` constant in `src/main.ts` (used for both `setGlobalPrefix` exclusion and path normalization helpers).

- `GET /` → service identity
- `GET /health` (and `/health/config`) → health/readiness + config dump (admin)
- `POST /billing/webhook` → Stripe signature-verified webhook (CSRF-exempt)
- `GET /.well-known/apple-app-site-association` → Apple universal links file

Everything else (the entire public product surface and all admin surfaces) is under the `/v1` prefix:

- Scalar API Reference (interactive, categorized docs for the full `/v1` surface) → `/docs` (enabled only in non-production)
- Raw OpenAPI JSON (for iOS codegen, Postman, CI, etc.) → `/openapi.json` (non-production only)

See `docs/api-contract.md` for the stability contract and type-sync process. The OpenAPI document (and Scalar) reflects the live routing, including the `/v1` prefix, automatically.

Any new unversioned surface must be added to `UNVERSIONED_ROOT_PATHS` (and the exclude list + normalization logic + these docs) in the same commit.

## Using from Next.js (local)

In your Next.js app, set the base to the versioned root (product routes live under `/v1`):

- `NEXT_PUBLIC_API_URL=http://localhost:3001/v1`

Then call (example for an unversioned infra endpoint; most product calls append their path under the `/v1` base):

- `${process.env.NEXT_PUBLIC_API_URL}/health`  (note: health is one of the few endpoints that stays at the raw host root)

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
