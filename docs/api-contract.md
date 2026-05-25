# API response contract and type sync

This document describes where each public API response type is defined and how to keep the API and www app in sync.

## Response type locations

| Endpoint | ResponseData | API definition | www definition |
|----------|--------------|----------------|-----------------|
| `GET /v1/posts` | `FeedPost[]` | `src/common/dto/post.dto.ts` (`PostDto`) | `menofhunger-www/types/api.ts` (`FeedPost`, `GetPostsData`) |
| `GET /posts/user/:username` | `FeedPost[]` | same | `GetUserPostsData` |
| `GET /posts/me/only-me` | `FeedPost[]` | same | `GetPostsData` |
| `GET /posts/:id` | `FeedPost` | same | `GetPostData` |
| `GET /posts/:id/comments` | `FeedPost[]` | same | `GetPostCommentsData` |
| `POST /posts` | `FeedPost` | same | `CreatePostData` |
| `GET /v1/users/:username` (public profile) | `{ user, pinnedPost? }` | `src/common/dto/user.dto.ts` (`UserDto`) + post | `types/api.ts` (`PublicProfileData`) |
| `PATCH /users/me/profile` etc. | `{ user }` | `UserDto` | consumed as `data.user` |
| `GET /v1/auth/me` | `{ user }` | `UserDto` | consumed as `data.user` |
| `GET /search` (type=bookmarks) | `SearchBookmarkItem[]` | search controller maps to post DTO | `SearchBookmarkItem` |
| `GET /v1/notifications` | list with custom DTO | `notification.dto.ts` | `NotificationDto` etc. |
| `GET /messages/conversations` | `MessageConversation[]` | `src/modules/messages/message.dto.ts` | `types/api.ts` (`MessageConversation`) |
| `GET /messages/conversations/:id` | `{ conversation, messages }` | `src/modules/messages/message.dto.ts` | `types/api.ts` (`GetMessageConversationResponse`) |
| `GET /messages/conversations/:id/messages` | `Message[]` | `src/modules/messages/message.dto.ts` | `types/api.ts` (`GetMessagesResponse`) |
| `POST /messages/conversations` | `{ conversationId, message }` | `src/modules/messages/message.dto.ts` | `types/api.ts` (`CreateMessageConversationResponse`) |
| `POST /messages/lookup` | `{ conversationId }` | `src/modules/messages/messages.service.ts` | `types/api.ts` (`LookupMessageConversationResponse`) |
| `POST /messages/conversations/:id/messages` | `{ message }` | `src/modules/messages/message.dto.ts` | `types/api.ts` (`SendMessageResponse`) |
| `GET /messages/unread-count` | `{ primary, requests }` | `src/modules/messages/messages.service.ts` | `types/api.ts` (`GetMessagesUnreadCountResponse`) |
| `GET /messages/blocks` | `MessageBlockListItem[]` | `src/modules/messages/messages.service.ts` | `types/api.ts` (`MessageBlockListItem`) |
| `GET /follows/:username/followers` | list with `UserListDto` | `src/common/dto/user.dto.ts` (`UserListDto`) | follow list types |
| Envelope | `{ data, pagination? }` | all controllers | `ApiEnvelope<T>`, `ApiPagination` in `types/api.ts` |

Key DTOs and types live in:

- **API:** `src/common/dto/user.dto.ts`, `src/common/dto/post.dto.ts`, `src/modules/notifications/notification.dto.ts`
- **www:** `menofhunger-www/types/api.ts` (single file for API envelope and response shapes used by the frontend)

## When you change an API response

1. Update the DTO (or mapper) in the API: `src/common/dto/*.ts` or the relevant module.
2. Update the corresponding type in **menofhunger-www** `types/api.ts` so the frontend type matches the new shape.
3. Run **menofhunger-www** typecheck: `cd menofhunger-www && npx nuxi typecheck`
4. Run the www API types validation script: `cd menofhunger-www && node scripts/validate-api-types.mjs`

Adding or removing fields, or changing types (e.g. `string` to `number`), will cause typecheck or the validation script to fail until `types/api.ts` is updated.

## Interactive Documentation

When running the API locally (`npm run dev`), the full v1 surface is available as beautiful, interactive documentation at:

- Scalar API Reference: http://localhost:3001/docs

All product routes now appear with their `/v1` prefix (e.g. `/v1/posts`, `/v1/auth/me`). This reference is generated automatically from the NestJS controllers, DTO mappers, and the central `DocumentBuilder` in `src/main.ts` (the `setGlobalPrefix` call makes the versioned paths appear automatically). Adding or updating a public route or controller makes it appear in the docs on the next restart (non-production).

The reference prominently documents:

- The success envelope `{ data: T, pagination? }` and error envelope.
- Cookie auth (`moh_session`) + CSRF Origin/Referer rules for unsafe methods.
- Cursor pagination and rate limiting behavior.
- The Realtime & Presence WebSocket events (with payload shapes from `realtime.dto.ts` and the PresenceGateway).

**Stability rule (repeated for emphasis):** API contracts are stable within v1. Any change that would break existing web or iOS clients must be introduced under a v2 (or later) surface only. The web-side type mirror (`menofhunger-www/types/api.ts`) and its validator (`scripts/validate-api-types.mjs`) plus the API's own DTOs (`src/common/dto/**`) remain the source of truth. Never edit a response shape without updating the mirror and running the validation steps.

Admin-only surfaces are intentionally excluded from the public reference.

## Unversioned Infrastructure Endpoints

A small number of operational endpoints are deliberately served at the document root (they never receive the `/v1` prefix). This list is the single source of truth and is defined as the `UNVERSIONED_ROOT_PATHS` constant in `src/main.ts`:

- `GET /` (service identity)
- `GET /health` and `GET /health/config`
- `POST /billing/webhook` (Stripe)
- `GET /.well-known/apple-app-site-association` (Apple universal links)

Any new unversioned surface must be added to `UNVERSIONED_ROOT_PATHS` (and the exclude list + normalization logic + these docs) in the same commit.

All other routes (public product surface and admin) live under `/v1`.
