---
name: gateway-unit-tests
description: Test MOH PresenceGateway/SpacesGatewayHandler behavior with the existing FakeSocket/FakeServer fixtures, without starting a server or Redis.
---

# Gateway unit tests

Start from `src/modules/presence/presence.gateway.spec.ts`. Its `buildGateway`
constructs the current extracted handlers; `makeFixture` wires the fake server
through `afterInit`. Reuse these rather than copying an old constructor signature.

- Register sockets and track fake room membership when asserting room delivery.
  Socket `join()` alone does not update `FakeServer`'s membership map.
- For watch-party state behavior, use the real `WatchPartyStateService` with the
  fixture's mocked Redis. Assert emitted payloads and resulting state, not just
  collaborator calls.
- Cover relevant multi-tab election, replacement/promotion, leave/disconnect,
  missing `isPlaying`, URL reset, stale-mode control, and reconnect cases.
- Include denied access/non-recipient assertions for changes to subscriptions or
  audience filtering. Fake transport cannot prove cross-process Redis delivery;
  test the owning bus/realtime service separately when that behavior changes.

References: [Space invariants](../../../.cursor/rules/50-spaces-gateway.mdc) and
[validation matrix](../../../docs/engineering-policy.md#validation-matrix).
