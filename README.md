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

## Endpoints

- `GET /` → `{ ok: true, service: "menofhunger-api" }`
- `GET /health` → `{ ok: true }`
- Swagger UI → `/docs`

## Using from Next.js (local)

In your Next.js app, set:

- `NEXT_PUBLIC_API_URL=http://localhost:3001`

Then call:

- `${process.env.NEXT_PUBLIC_API_URL}/health`

