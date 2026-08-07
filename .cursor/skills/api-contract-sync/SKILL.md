---
name: api-contract-sync
description: >-
  Keep API response contracts and client consumption synchronized across API, web, and iOS. Use
  for DTO/model/realtime changes, decoding work, or when a feature/preview exists on one client but
  is missing on another.
---

# API Contract Sync

Use this when a response shape, DTO, envelope, realtime payload, or decoded client model changes.
Also use it when one client already renders richer API-backed UI than another: missing consumption
of an existing field is still a contract-parity bug.

## Before changing the contract

1. Apply the product algorithm: should this field/endpoint exist, or can an existing resource carry it?
2. Identify consumers:
   - API DTOs: `menofhunger-api/src/common/dto/**` and owning-module `*.dto.ts` files
   - Web types: `menofhunger-www/types/api.ts` and generated contract checks
   - iOS models: `menofhunger-ios/MenOfHunger/**/Model` and shared models
   - Realtime payloads: API emit methods and web/iOS socket handlers
3. Inspect the actual DTO and both clients before adding an endpoint or field. Reuse an existing
   optional preview/mutation when it already carries the needed data.

## Required sync

- API controllers return the envelope explicitly: `{ data }` or `{ data, pagination }`.
- Web mirrors changed response shapes in `types/api.ts`; run `npx nuxi typecheck` and `node scripts/validate-api-types.mjs`.
- iOS updates the matching `Decodable` model and adds/updates a decoding test for any non-trivial or newly consumed shape.
- Realtime payloads reuse the same DTO shape as HTTP unless there is a clear product reason not to.
- A client feature that starts consuming an existing optional field still requires a fixture that
  decodes the full nested shape and a UI path that handles missing/null values.
- Preserve server strings exactly when case is meaningful (for example case-only username edits);
  do not lowercase/normalize in a client unless the API contract says to.
- Error envelopes are part of the contract: iOS exposes the API message through `LocalizedError`
  and UI uses `safeUserFacingMessage`, while technical decoding/transport details stay in Debug logs.

## Red flags

- A field exists only on one client because parity was assumed.
- A new endpoint exists only because changing an existing DTO felt scary.
- Web and iOS decode the same data with different names or optionality.
- A socket payload has a parallel model for the same entity.
- Web displays DTO-backed preview/content that iOS silently drops, or vice versa.
- A client assumes "field absent" without checking the live DTO and the other client first.
