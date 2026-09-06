# Getting started with the API

The API owns authentication, authorization, persisted product data, and background work for the Nuxt website and SwiftUI app. Start here, then use [the API contract](api-contract.md) and the local `/docs` reference for endpoint details.

## One-command setup

From the repository root:

```sh
./init.sh
```

This checks Node and Docker, creates `.env` only if missing, refuses production/remote database configuration, starts local Postgres and Redis, installs dependencies, applies committed migrations, and starts the API with SMS disabled. Existing `.env` values are preserved. Docker must already be running.

Use `./init.sh --setup-only` to prepare dependencies without launching the app, or `./init.sh --help` for usage. Reruns reinstall locked Node dependencies where applicable but do not reset data, overwrite configuration, or kill existing servers. The manual steps below are useful for troubleshooting.

## First local run

Run these commands from `menofhunger-api`. Keep `menofhunger-www` and `menofhunger-ios` as sibling checkouts when working across clients; contract generation can update the sibling website.

1. Install the Node version in [`.nvmrc`](../.nvmrc) and Docker with Compose. [package.json](../package.json) declares the supported Node minimum.
2. Create your local configuration without overwriting an existing file:

   ```sh
   test -f .env || cp env.example .env
   ```

   In `.env`, use the local database and Redis URLs from [env.example](../env.example), `NODE_ENV=development`, `ALLOWED_ORIGINS=http://localhost:3000`, and `DISABLE_TWILIO_IN_DEV=true`. Leave `COOKIE_DOMAIN` unset locally. Keep credentials in your untracked environment file; production provider credentials are unnecessary for basic local login.
3. Start dependencies, install the locked packages, and apply existing migrations:

   ```sh
   docker compose up -d --wait db redis
   npm ci
   npx prisma migrate deploy
   npm run dev
   ```

   `npm ci` runs Prisma generation through `postinstall`. Confirm `DATABASE_URL` points to your local database before migrating. `npx prisma migrate deploy` applies committed migrations; the repository's `prisma:migrate:deploy` wrapper also performs deployment repair/backfill work. Use `npm run prisma:migrate` when deliberately developing a schema change. Run the dev server in your own terminal; check `npm run dev:check` before starting another instance.
4. In another terminal, verify the unversioned health route and the versioned auth route:

   ```sh
   curl --fail http://localhost:3001/health
   curl --fail http://localhost:3001/v1/auth/me
   ```

   Without a cookie, `/v1/auth/me` returns `data: null`. Browse [the local API reference](http://localhost:3001/docs). Sign in from either client with a synthetic local phone such as `+12025550123` and code `000000`, then complete onboarding. The dev bypass works only on a non-production API. No seed is required to create that account.

These are the individual steps performed by the initialization script; use them to isolate setup failures.

## Eight things to understand

### 1. Follow a request from controller to service to database

[src/main.ts](../src/main.ts) installs middleware and the `/v1` prefix. Feature modules in [src/modules](../src/modules) group controllers, services, and providers. Controllers validate inputs and expose routes; services implement behavior; [Prisma](../src/modules/prisma/prisma.service.ts) accesses Postgres using [schema.prisma](../prisma/schema.prisma). Read a neighboring feature before adding a new pattern.

Product routes use `/v1`; infrastructure exceptions such as `/health` are listed in `UNVERSIONED_ROOT_PATHS` in `main.ts`. A client base ending in `/v1` must not be used unchanged for root health probes.

### 2. Phone verification creates both accounts and sessions

The components are [AuthController](../src/modules/auth/auth.controller.ts), [AuthService](../src/modules/auth/auth.service.ts), the [Twilio Verify provider](../src/modules/auth/otp/twilio-verify-otp.provider.ts), and the `PhoneOtp`, `User`, and `Session` models.

```text
POST /v1/auth/phone/start { phone }
  -> normalize phone -> check resend cooldown/account state
  -> Twilio sends SMS -> record PhoneOtp bookkeeping
POST /v1/auth/phone/verify { phone, code }
  -> validate six digits -> check active OTP -> Twilio approves
  -> consume OTP -> create/reuse user -> create Session
  -> Set-Cookie: moh_session=... + JSON user/session metadata
```

The OTP bookkeeping lasts 10 minutes, with a 30-second resend cooldown. Twilio owns the actual verification code: `PhoneOtp.codeHash` hashes a random placeholder, not the submitted SMS code. Route throttles default to 8 starts and 20 verifications per 60 seconds; configuration can override them. The throttler tracks authenticated requests by user and anonymous requests by IP, separately from the per-phone resend cooldown. See [auth constants](../src/modules/auth/auth.constants.ts) and [AppConfigService](../src/modules/app/app-config.service.ts).

There are two explicit bypasses in `verifyPhoneCode`: `000000` outside production, and a configured `APP_REVIEW_PHONE`/`APP_REVIEW_CODE` pair that also works in production. Treat that pair as a credential and do not put its values in docs or clients. `DISABLE_TWILIO_IN_DEV` suppresses sending; it does not make arbitrary codes valid.

### 3. The login credential is an opaque session cookie

[randomSessionToken](../src/modules/auth/auth.utils.ts) generates 32 cryptographically random bytes encoded as base64url. The client receives the raw token in `moh_session`. Postgres stores only `HMAC-SHA256(SESSION_HMAC_SECRET, token)` in `Session.tokenHash`; the JSON `sessionId` is an identifier, not the login token. This flow uses neither a JWT nor an access/refresh-token pair.

Cookies are `HttpOnly`, `SameSite=Lax`, path `/`, and `Secure` in production. Production defaults to domain `.menofhunger.com`; development uses a host-only cookie. Normal sessions last 30 days. With fewer than 7 days remaining, resolution extends the expiry by 30 days and HTTP handlers refresh the cookie using the same token.

Server-only configuration includes `SESSION_HMAC_SECRET`, `OTP_HMAC_SECRET`, and Twilio account/auth/service values. Production startup rejects missing or development-default HMAC secrets. Changing the session HMAC secret makes existing tokens fail lookup. Avoid logging raw cookies, OTPs, or provider secrets. Phone numbers are stored as strings in Postgres; the Twilio provider currently logs full destination numbers even though `AuthService` masks its own phone logs.

### 4. Authentication and permission checks are separate

```text
Cookie -> cookie-parser -> AuthGuard -> AuthService.meFromSessionToken
       -> HMAC lookup -> Redis cache or Postgres -> req.user -> handler
```

[AuthGuard](../src/modules/auth/auth.guard.ts) rejects a missing/invalid session with 401. Database resolution checks expiry, revocation, and bans. Results are cached in Redis for up to 30 seconds, with request memoization and concurrent-lookup deduplication. Cache invalidation matters when changing user permissions or session state.

[OptionalAuthGuard](../src/modules/auth/optional-auth.guard.ts) supports anonymous reads. [VerifiedGuard](../src/modules/auth/verified.guard.ts) checks verified/premium eligibility, and [AdminGuard](../src/modules/admin/admin.guard.ts) handles admin access. Hiding a client button does not enforce a permission: enforce access in the API.

Logout revokes the session, invalidates session caches, and clears the cookie. `/auth/sessions/revoke-all` covers the user's devices and sessions they operate or impersonate. Admin impersonation records the real admin separately and uses a fixed one-hour session; page switching records the operator. [Browser handoffs](../src/modules/auth/browser-handoff.service.ts) use a separate 90-second code, SHA-256-keyed in Redis and atomically consumed, to mint a new browser cookie.

### 5. Origins and realtime are part of authentication

[main.ts](../src/main.ts) enables credentialed CORS for configured origins and checks `Origin`/`Referer` on unsafe HTTP methods. Missing origin headers are rejected in production by default, with explicit webhook exceptions. This is the implemented CSRF mechanism; there is no separate client CSRF token in this flow.

Browsers send cookies with `credentials: 'include'`. iOS supplies its stored token in a `Cookie` header and supplies production CSRF headers. [PresenceGateway](../src/modules/presence/presence.gateway.ts) authenticates Socket.IO connections with the same session cookie. Socket.IO connects at `/socket.io` on the API host, not a REST `/v1/socket.io` route.

### 6. API response changes affect both clients

Read [api-contract.md](api-contract.md). DTOs and mappers define the wire contract; Prisma models are not client response schemas. Preserve compatibility for shipped clients within v1.

After an intentional DTO change, run `npm run emit:contracts`. It writes [contracts/api-contracts.gen.ts](../contracts/api-contracts.gen.ts) and, if present, the sibling website's generated mirror. Update the website's hand-maintained types and the iOS `Decodable` models as needed. The website's `validate-api-types` checks contract wiring; its TypeScript check verifies assignability. Review generated diffs in both repos.

### 7. Redis and workers are core dependencies

Redis supports session caching, realtime state, and BullMQ jobs. `RUN_HTTP`, `RUN_SCHEDULERS`, and `RUN_JOB_CONSUMERS` select process roles; local defaults enable all three. See [README](../README.md) and [deployment notes](../DEPLOYMENT.md) before changing those flags. Uploads, billing, push, and other integrations need their own configuration when you work on those features.

### 8. Finish a change with the existing checks

Run focused tests while developing, then the checks used by [CI](../.github/workflows):

```sh
npm run lint
npm run build:typecheck
npm run build:ci
npm run test:ci
npm run test:e2e
npm run emit:contracts
git diff --exit-code contracts/
```

The final command detects generated drift against the index; expected contract changes must be reviewed and included in the change. `npm run build` additionally invokes the module-graph postbuild check. Do not use database reset or production seed commands as a routine setup repair.

## If setup fails

| Symptom | First check |
| --- | --- |
| Database connection fails | `docker compose ps`; local `DATABASE_URL`. If changing `POSTGRES_PORT`, change the URL port too. |
| Redis connection fails | Redis container health and `REDIS_URL`. |
| Health returns 404 | Request `/health`, not `/v1/health`. |
| Login works but the next request is anonymous | Cookie domain, `localhost` versus `127.0.0.1`, client credentials, and allowed origin. |
| Unsafe request returns 403 | `Origin`/`Referer` and CSRF configuration in `main.ts`. |
| SMS is unavailable locally | Use a development API, disable Twilio locally, and submit `000000`. |
| API reports 429 | Respect the retry interval; do not add automatic retry loops to OTP sending. |
