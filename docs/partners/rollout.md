# Partner API rollout and operations

This branch adds the MOH-side launch implementation. Do not enable a production client merely because documentation is deployed. Use synthetic test accounts first. No live-member content is a test fixture.

## Prerequisites and switches

Run API Node 24 (`.nvmrc`, Docker and CI agree). The dedicated provider is pinned to `oidc-provider` 9.12.2. Existing first-party authentication and MCP routes are separate.

Apply the additive migration through the normal release path after taking the usual database backup. It audits unconfirmed/duplicate Pickax IDs into `identity_conflict`, backfills connection generations, imports historical remote mappings, and reserves current-month X usage. Inspect flagged identities before reauthorization. Legacy page connections without a confirmed authorizing operator require a current operator to reauthorize. Never resolve duplicate ownership by guessing from a username.

Provision a dedicated `PARTNER_ENCRYPTION_KEY` (at least 32 random characters), and `PARTNER_OIDC_JWKS` containing private signing JWKs with unique `kid`, `alg: RS256`, and `use: sig`. Keep these in the secret manager. Never check private keys into source. To rotate, introduce a new signing key while retaining the previous verification key, verify discovery/JWKS and new signatures in the test client, and keep old public keys for at least the longest outstanding ID-token lifetime plus clock skew. Keep the encryption key stable unless encrypted records are deliberately rewrapped.

Independent switches, off by default:

- `PARTNER_API_ENABLED`: OAuth and authenticated partner reads.
- `PARTNER_WEBHOOKS_ENABLED`: scoped webhook dispatch.
- `PICKAX_OAUTH_ENABLED`: proposed reciprocal OAuth, only after Pickax contract acceptance.
- `PICKAX_REMOTE_DELETE_ENABLED`: only after confirmed remote removal testing.
- `X_COUNT_ALLOWANCE_ENABLED`: new 50/3 and 300/20 counters; migrate history before activation.

`OUTBOUND_DELIVERY_PAUSED=true` stops sending outward jobs while retaining outbox, mapping and allowance history. It does not erase pending work. Disable partner API/webhooks to pause new partner work. Suspend a single client through `PATCH /v1/admin/partners/{id}` with `active:false`. Never delete grants or quota history as a rollback.

## Administration

All these routes retain AdminGuard and are excluded from partner OpenAPI:

- `GET/POST /v1/admin/partners`: list or register confidential clients. Create separate test and production Pickax clients. `platform:"pickax"` selects the launch allocation. Supply exact HTTPS redirects, scopes, and webhook URL/events. Secrets are returned once.
- `PATCH /v1/admin/partners/{id}`: suspension, allocation, webhook URL/subscriptions.
- `GET /v1/admin/partners/{id}/deliveries`: most recent 100 delivery diagnostics.
- `POST /v1/admin/partners/{id}/deliveries/{deliveryId}/replay`: explicitly replay retained completed/failed events; current permission checks still apply.
- `POST /v1/admin/partners/{id}/webhook-secret`: rotate, retaining the previous signing secret.
- `POST /v1/admin/partners/{id}/webhook-secret/retire-previous`: remove overlap after the partner confirms the new secret.

Public documentation is mirrored into web `/developers`. Source: `docs/partners/pickax.md`. The example is `examples/partner/client.mts`. Regenerate/sync their public copies after editing. Live partner OpenAPI is generated from the actual controller/DTO decorators, with a route allowlist; internal/admin endpoints are excluded.

## Verification commands

- `npm run build:typecheck`, changed-file ESLint, `npm run build`.
- `npm run check:contracts`, `npm run check:env-docs`.
- `npm run test:partner-protocol`: real provider and maintained OIDC client, entirely synthetic.
- `npm run check:partner-example`: runnable example TypeScript.
- `npm run check:partner-database`: disposable PostgreSQL, pinned baseline + migrations, drift check, transaction/visibility/quota fixtures. Requires Docker; never reads a production database target.
- Relevant Jest suites in partner, outbound, Pickax, X, scheduled posts and media-review coverage.
- Web types, focused crosspost tests, lint, Nuxt build and browser consent/denial checks.
- iOS strict format/lint, simulator build, integration decoding/crosspost tests and connection-management interaction.

The Pickax adapter fixtures intentionally do not assert that Pickax has shipped OAuth, idempotency or deletion. Enable those switches only after both teams pass code/refresh/revoke/identity/create/update/delete fixtures against their test service. Remote errors and uncertain creates require inspection rather than a second unconfirmed create.

## Monitoring and product success

`partner_connection_started` records the anonymous entry, using a one-way flow identifier rather than a browser credential. `partner_connection_authenticated` records the returning human before consent, including declined connections. `partner_attributed_signup` records accounts created during that authorization journey. These events are deduplicated for the interaction. `partner_oauth_completed` records client/account/grant IDs without credentials and sets the first partner client on the human's analytics profile. Join that cohort to existing `user_signed_up`, verification, publication and retention events; a connection is not itself product success. `outbound_delivery_result`, `outbound_delivery_failed`, and `partner_webhook_failed` provide launch diagnostics. Outbox rows and `XUsageReservation` are the accounting source of truth; existing crosspost cost estimates remain for reporting. Inspect uncertain creates for duplicates before authorizing retries.

Track conversion to completed verification, first MOH publication and retained activity, alongside consent completion, webhook failures, delivery success and X estimated spend. Validate the complete production dashboard and signup return journey before launch. A signup that never resumes its partner journey cannot be joined to the anonymous start event; do not infer acquisition solely from a later connection.

## Design handoff

Existing UI library: https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN

Settings state frames: Connections light `989:302`, dark `989:375`; X light `989:323`, dark `989:392`; Pickax connection light `989:340`, dark `989:409`; sharing status light `989:357`, dark `989:426`. Paused page-operator states: light `994:334`, dark `994:347`. These use the existing typography, variables and button instances.

## Local acceptance record — 2026-09-30

Completed against synthetic data; no real member posts were sent:

- API: 405 focused Jest checks across partner access, connection management, idempotency, outbound lifecycle, Pickax/X, scheduling, existing post/article behavior and media schema coverage. Typecheck, changed-file lint, production compilation, module graph and admin-route coverage passed.
- Real `oidc-provider` + `openid-client` interoperability: discovery/JWKS, PKCE, exact redirects, state/nonce, signup/onboarding return, consent/denial, signed ID tokens, distinct UserInfo/resource audiences, refresh races/replay, later token-family reuse and deduplicated acquisition events passed.
- Disposable PostgreSQL: additive migration and drift checks, transactional outbox, public/private transitions, physical/soft comment removals, immutable pairing IDs, concurrent X reservations, 50/3 accounting, uncertain reservations and reconnect usage floor passed.
- Web: 24 focused component/utility checks, including paused access, revocation, removal status, API-error recovery, per-post destinations and onboarding return. Public guide inspected at phone width in both themes. The final production build, browser denial/invalid-continuation checks and all 45 routes in the hydration gate passed, including the onboarding-gate wiring.
- iOS: strict formatting/lint, simulator build and launch, and 10 focused tests passed, including legacy/null decoding, page access status, scheduling choices, link accounting and removal wording.
- Partner-only OpenAPI, example TypeScript, synchronized public documentation, shared contracts and environment documentation checks passed.

Production activation is separate. Configure dedicated signing/encryption keys and approved test clients, then exercise authenticated personal/page journeys on staging and native devices. The local simulator could launch, but its configured API was unavailable, so authenticated native connection interaction is **not** recorded as passed. Pickax OAuth/removal remain disabled until the proposed provider contract passes against Pickax test accounts. Do not present the synthetic-provider results as proof of Pickax's live capabilities.
