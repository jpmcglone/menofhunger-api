# Group channels implementation ledger

Source: approved implementation plan in this task; Figma pages 29 and 30.

## Release controls

`GROUP_CHANNELS_ENABLED=false` by default. `GROUP_CHANNELS_GROUP_IDS` is a comma-separated pilot allowlist; empty permits all groups only when enabled. `GROUP_CHANNELS_MARV_ENABLED=false` independently gates the second rollout stage. Never enable production during implementation.

## Milestones

- [x] 0: Figma reconciliation, complete action/state inventory.
- [x] 1: schema, access, capabilities, lifecycle, provisioning, ownership transfer.
- [x] 2: messages, threads, reactions, pins, search, idempotency, reports, protected media. Protected media still needs a private channel bucket (`R2_CHANNEL_BUCKET_NAME`) for a live upload check.
- [x] 3: realtime, revocation, attention, preferences, push and badges.
- [x] 4: iOS navigation, timelines, management, actions, destination drafts.
- [x] 5: web parity, keyboard/touch, hydration.
- [ ] 6: human pilot acceptance (requires deployment and real pilot participation).
- [ ] 7: MARV participation, scoped retrieval, cancellation, consent/credits tests.
- [ ] 8: broader rollout (after pilot acceptance).

## Non-negotiable boundaries

Channel access requires active verified group membership. Open-group post preview does not grant channel access. Leaders have no private-channel read bypass. Default channels are protected. Chat participant rows never authorize channel access. Channel media is private and every read is authorized. MARV cannot move private context between destinations. Home exits context, never membership. Existing global navigation is retained.

## Working state

All three repositories are on main. The migration is applied to the local development database only, with channels backfilled and `GROUP_CHANNELS_ENABLED=true` in the local `.env`. No pilot or production flag has been enabled.

## Implemented

- Reconciled Figma navigation, supported media, Info/Restore actions, duplicate controls and draft switching.
- Added the dedicated API channel domain, additive migration and idempotent default provisioning/backfill script. Access, lifecycle, messages, threads, reactions, pins, search, reports, protected media, attention, realtime and push are implemented behind disabled flags.
- Ownership transfer is a group operation (`POST /groups/:groupId/members/:userId/transfer-ownership`), available whether or not channels are enabled.
- Search covers every readable channel in a group (`GET /groups/:groupId/channels/search?q=&channelId=`); `channelId` narrows it to one channel.
- Reconnect catch-up uses `GET …/messages?changedSince=<revision>`, which returns sends, edits, deletions, reactions and pins in revision order. Clients reload the window when a catch-up page is full.
- A deleted message stays visible only as the placeholder root of replies that still exist.
- Channel push fan-out runs in `ChannelNotificationsSideEffectsHandler`; the request path only records viewing leases.
- iOS includes channel navigation, management, author rows, threads, native actions, group search/attention, protected media, an extended outbox and local destination drafts.
- Web includes matching channel routes, responsive panes, touch/keyboard actions, management, group search, protected media, IndexedDB drafts and outbox behavior.
- Shared Chat menus retain Info and Restore. Article reporting and ownership transfer are available on both clients.

## Validation recorded so far

- API: `npm run check` (guidance, env docs, lint, typecheck, contracts, build, module graph, 3,259 unit tests, media, e2e, MCP) plus the partner checks and `check:database` pass. `scripts/check-group-channels-database.sh` passes 12 channel integration tests on a disposable database.
- Web: env docs, lint, typecheck, API type validation, 255 files / 1,715 tests, production build and all 47 hydration routes pass.
- iOS: format, strict lint, simulator build and the full 1,169-test suite pass.
- Local two-user check on localhost: sends, replies, reactions, deletions and deleted-root placeholders update live; group search spans readable channels and opens the matched message; the Posts tab badge updates live; ownership transfer is offered to owners.

Remaining gates: a live protected-media upload once a private channel bucket exists, MARV's separate second stage, and pilot/rollout acceptance. No pilot or production flag has been enabled.
