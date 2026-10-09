---
name: api-contract-sync
description: Synchronize changed MOH API DTOs, realtime payloads, and web/iOS decoding, including newly consumed fields.
---
# API contract sync

Inspect the owning DTO and actual consumers before adding a field or endpoint:
- API: `src/common/dto/**`, domain `*.dto.ts`, and `PresenceRealtimeService`.
- Web: `types/api.ts`, `types/api-contracts.gen.ts`, consuming composables/socket handlers.
- iOS: matching domain models, transport decoding, and store/service reducers.
Paths are relative to each repository; locate active checkouts rather than assuming siblings.

Update affected consumers together. Generate contracts with API `npm run emit:contracts`;
check with `npm run check:contracts` and web `npm run validate-api-types` plus typechecking.
Use the [validation matrix](../../../docs/engineering-policy.md#validation-matrix) for platform gates.

Snapshots reuse DTOs; patches distinguish absent from null. Preserve case-sensitive server
strings and recipient permissions. Follow the [realtime policy](../../../docs/engineering-policy.md#realtime-contracts-and-ownership).
Cover meaningful decoding/merge changes with nested fixtures, including missing/null fields.
When one client lacks an existing preview, inspect its consumption before changing the API.
Use web `getSafeUserErrorMessage` / iOS `safeUserFacingMessage` for display errors;
transport/decoding details belong in diagnostics.
