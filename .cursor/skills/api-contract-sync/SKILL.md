---
name: api-contract-sync
description: Keep API response contracts synchronized across menofhunger-api, menofhunger-www, and menofhunger-ios. Use when adding or changing DTOs, API response shapes, realtime payloads, generated/manual web types, or iOS Decodable models.
---

# API Contract Sync

Use this when a response shape, DTO, envelope, realtime payload, or decoded client model changes.

## Before changing the contract

1. Apply the product algorithm: should this field/endpoint exist, or can an existing resource carry it?
2. Identify consumers:
   - API DTOs: `menofhunger-api/src/common/dto/**`
   - Web types: `menofhunger-www/types/api.ts` and generated contract checks
   - iOS models: `menofhunger-ios/MenOfHunger/**/Model` and shared models
   - Realtime payloads: API emit methods and web/iOS socket handlers

## Required sync

- API controllers return the envelope explicitly: `{ data }` or `{ data, pagination }`.
- Web mirrors changed response shapes in `types/api.ts`; run `npx nuxi typecheck` and `node scripts/validate-api-types.mjs`.
- iOS updates the matching `Decodable` model and adds/updates a decoding test for any non-trivial or newly consumed shape.
- Realtime payloads reuse the same DTO shape as HTTP unless there is a clear product reason not to.

## Red flags

- A field exists only on one client because parity was assumed.
- A new endpoint exists only because changing an existing DTO felt scary.
- Web and iOS decode the same data with different names or optionality.
- A socket payload has a parallel model for the same entity.
