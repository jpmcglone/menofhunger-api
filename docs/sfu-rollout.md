# SFU-only calling rollout

## Product decision — October 2, 2026

The owner approved a **best-effort $50 monthly application allowance**, accepting possible
provider overage. This replaces the earlier requirement for a provider-enforced hard cap.
`CALLS_BUDGET_BOUND_VERIFIED` is removed: do not set it or represent this ledger as a
Cloudflare billing limit. Calling uses Cloudflare SFU without TURN.

## Architecture

All direct and group calls use Cloudflare SFU. Direct capacity remains two, group capacity
four. Each participant has one publisher and a receiver for each remote participant.
Authenticated socket events own ringing, seats, reactions, device takeover, and call state.
Client-to-client SDP/ICE forwarding, mesh media, data-channel reactions, Google STUN defaults,
static TURN providers, and manual relay switching are removed. There is no P2P fallback.

Clients connect directly to Cloudflare SFU. The API supplies `stun:stun.cloudflare.com:3478`
for address discovery; STUN does not relay media and needs no credentials. TURN credential
minting, caching, and call-admission gates are removed. Long-lived SFU secrets stay on the API.
Old clients without SFU capability/session identity get `client_update_required`.
Missing infrastructure gets `calling_unavailable`.

Both clients keep recovery deadlines outside replaceable media connections and retry within
30 seconds. Native video uses the web quality ladder, preserving audio as video degrades.
Replacing a receiver may briefly interrupt media; overlapping seamless replacement is not implemented.

## Browser refresh and reconnect

Page lifecycle events never emit `calls:leave`: browsers cannot reliably distinguish refresh,
close, and suspension. Explicit Hang Up still leaves immediately. A disconnected participant
keeps a reconnecting seat for 30 seconds; the other person stays in the call while they return.

The tab stores a short-lived resume marker in sessionStorage on page exit. Only a reload
may consume it, after authentication and signaling reconnect. The client verifies the original
server seat and passes `resumeSessionId` on `calls:join`. The API checks it under the conversation
lock, so reload cannot take a newer device's seat or resurrect an expired participant. A fresh
media-session identity rebuilds the SFU publication. Mic/camera choices are preserved; screen
sharing requires a fresh explicit action. An outgoing caller's reload does not answer its own ring.

## Best-effort budget reservations

`CallBudgetMonth` and `CallBudgetLease` in PostgreSQL are the cross-instance authority.
Reservations use a transaction advisory lock and the database clock. Clients cannot authorize
spending through traffic reports. There are no refunds based on estimated usage.

- Allowance: 1 TB/month, equivalent to $50 at $0.05/GB. Shared provider free usage is not credited.
- Default reservation estimate: 1,000,000 bytes/sec per capacity-squared unit. This includes
  generous headroom above normal encoder rates for simultaneous tracks, retries and overhead.
  It is **not** a provider-enforced traffic bound or a prediction of the final bill.
- Reserve 120 seconds plus 60 seconds of cleanup/reporting allowance before call admission.
  Renewal begins with 90 seconds remaining and conservatively reserves another full interval.
- Every new provider allocation checks the durable lease. Database errors block new allocations.
- The 15-second sweep warns callers and ends calls at their reserved deadline. Failed provider
  cleanup is retried. Scheduler outages and provider cleanup/reporting
  delays can exceed estimates; operational availability remains necessary.
- Intervals crossing UTC month boundaries are reserved in both months. New months do not erase
  existing reservations. Conservative accounting can stop calls before $50 is actually billed.

## Configuration and deployment

- `CLOUDFLARE_SFU_APP_ID`, `CLOUDFLARE_SFU_APP_SECRET`
- `CALLS_SFU_ENABLED`: operational admission switch, defaults false.
- `CALLS_BUDGET_BYTES_PER_SECOND`: positive reservation estimate, defaults 1,000,000.
- `RUN_SCHEDULERS=true` and Redis cleanup state must remain available.

Apply `20261002140000_call_budget` through the API's configured Render pre-deploy command.
The migration only adds two accounting tables and an index. API and web track main and deploy
when CI passes. Older iOS clients need the SFU-capable release; publish the native update too.
Rollback should disable new calling, not reintroduce P2P. Existing P2P calls cannot migrate in
place and should be ended/restarted during the cutover.

Cloudflare app `menofhunger-production-sfu` was created for this rollout because the existing
app's creation-time secret was not configured on Render and cannot be retrieved through the
management API. Its secret is delivered only to Render environment configuration.

## Local development and connection troubleshooting

Local API configuration is independent of Render. Configure `CALLS_SFU_ENABLED=true`,
`CLOUDFLARE_SFU_APP_ID`, and `CLOUDFLARE_SFU_APP_SECRET` locally.
Use a development SFU app where available. Do not put provider secrets in web or iOS settings.
Run local Postgres/Redis and the API with schedulers; point web and the iOS API selector at
that same local API. Restart the API after changing its environment.
After deploying this API change, `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` are unused
and can be removed from deployment settings.

Both clients gather candidates before creating a publishing session, then publish, apply the
answer, wait for connectivity, and announce readiness. Gathering waits up to ten seconds;
usable candidates are retained if the STUN endpoint has not responded. No candidates
still fails. Receivers also have a fifteen-second connection deadline. A participant is connected
only when the local publisher and that participant's receiver are connected.

For failures, inspect `[moh-call] sfu.failed` in web, `SFU failed` in the native `calls.media`
log category, and `[calls] SFU failed` in API logs. Client logs identify the failed stage;
API logs identify the operation, role, and safe provider HTTP/network/negotiation category.
Neither SDP nor provider credentials are logged.

Focused tests include an actual native WebRTC handshake and an unreachable-STUN regression.
A local browser relay demonstrated two-way rendered video through the web transport. These
local checks do not establish Cloudflare connectivity or iOS↔web interoperability; those
still require configured SFU credentials and two authenticated development clients.

## Validation and remaining live checks

Local gates cover API calls/provider/gateway regressions, isolated PostgreSQL reservation
concurrency and rollover, web lifecycle/transport tests, contract checks, builds, and native
SFU recovery/decoding/quality tests. See the release report for final counts.

These checks do not prove physical-device or adverse-network compatibility. Follow up with
browser↔browser, browser↔iOS, and iOS↔iOS calls on Wi-Fi, cellular, and handover.
Networks that require a TURN relay are outside this direct-to-SFU configuration.
Exercise refresh, camera off/on, screen sharing, explicit Hang Up, device takeover,
and exhausted grace. Review actual Cloudflare usage against the conservative application ledger.

Figma: [calling warning and availability states](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1080-169).

Provider references: [SFU pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/),
[SFU connection patterns](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/).
