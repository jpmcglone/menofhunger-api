# Cloudflare SFU rollout (in progress)

The rollout flag defaults off. This work has not been deployed or validated against a live
SFU application yet. Keep `CALLS_SFU_ENABLED=false` until the remaining gates pass.

## Paused at user request — September 28, 2026

- Cloudflare OAuth now works. Production app `menofhunger-production` was created:
  `8a55305f3b447f7a97918b6929a9b437` in account `ebd808e5f3739461ff68e4229b7eb6f3`.
- API host credentials have NOT been configured. Secret was retained only in the tool session;
  do not print it. Confirm availability or securely recover/rotate it when resuming.
- User confirmed Render workspace **JP McGlone LLC**, `tea-cspqdel6l47c73c4mprg`.
- User chose **$50/month combined SFU/TURN, end active paid calls after a warning**.
  Enforcement and warning implementation remain pending; this is not an active provider cap.
- Latest API source/seat race and cleanup regression suite: **14 tests passed**.
  Changed-file lint and API typecheck were launched before the pause; retrieve their results
  before treating them as passed.
- No SFU commits, pushes, releases, deployment or enablement have occurred.

## Current implementation

- Cloudflare SFU signaling is proxied through the authenticated `calls:sfu` socket action.
  The App ID and secret stay in API configuration.
- New SFU-capable group calls select SFU when explicitly enabled. Direct calls remain P2P
  with the existing STUN/TURN configuration. Legacy calls remain P2P for their lifetime.
- Old clients receive an update-required response when joining an SFU call.
- Each participant uploads once. Separate receiving connections isolate peer recovery.
- Publish, subscribe, answer, unpublish, readiness and cleanup operations are serialized.
- Provider session identifiers are resolved from server-owned call-seat state; subscription
  requests identify MOH participants, not arbitrary provider sessions.
- Expired/moved seats are revoked, with a sweep retrying provider cleanup failures.
- Web uses the existing adaptive encoder manager. Native currently retains its video cap.
- Camera reactivation republishes tracks, rather than assuming an inactive publication survives.
- SFU reactions use authenticated, rate-limited socket signaling.

## Configuration

- `CLOUDFLARE_SFU_APP_ID`: the production SFU app ID.
- `CLOUDFLARE_SFU_APP_SECRET`: server-only provider secret, configured through the host.
- `CALLS_SFU_ENABLED`: default false. Credentials alone do not activate routing.

Use a separate Cloudflare app for nonproduction integration tests. Do not put secrets in
repository files, logs, clients, or screenshots.

## Remaining work before rollout

1. Configure the created production SFU app credentials securely on the confirmed Render API
   service, keeping the rollout disabled. Create a separate test app for live validation.
2. Finish native adaptive quality, server spend reservations/usage controls, and the agreed
   monthly budget/exhaustion behavior: $50/month, warn then end active paid calls. Cloudflare
   alerts do not enforce a hard bill cap; client-reported traffic must not authorize spending.
3. Review seamless P2P-to-SFU migration for growing groups. Current selection happens at call
   creation; there is no mid-call topology migration yet.
4. Review receive-side quality, publication/subscription replacement continuity, bounded
   recovery, provider timeout/partial-success handling and multi-instance cleanup.
5. Exercise actual browser↔browser, native↔browser and native↔native calls through Cloudflare:
   audio, camera off/on after 30+ seconds, screen share, reactions, join/leave, device takeover,
   Wi-Fi/cellular changes, restrictive networks, reconnect, and budget exhaustion.
6. Finish the API/web/native completion gates, then commit, push, configure deployment,
   upload the native build, and enable the rollout only after live verification.

References:
- https://developers.cloudflare.com/realtime/sfu/api/
- https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/
- https://developers.cloudflare.com/realtime/sfu/platform/limits/
- https://developers.cloudflare.com/realtime/sfu/platform/pricing/
