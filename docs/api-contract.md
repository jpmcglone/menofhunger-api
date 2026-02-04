# API response contract and type sync

This document describes where each public API response type is defined and how to keep the API and www app in sync.

## Response type locations

| Endpoint | ResponseData | API definition | www definition |
|----------|--------------|----------------|-----------------|
| `GET /posts` | `FeedPost[]` | `src/common/dto/post.dto.ts` (`PostDto`) | `menofhunger-www/types/api.ts` (`FeedPost`, `GetPostsData`) |
| `GET /posts/user/:username` | `FeedPost[]` | same | `GetUserPostsData` |
| `GET /posts/me/only-me` | `FeedPost[]` | same | `GetPostsData` |
| `GET /posts/:id` | `FeedPost` | same | `GetPostData` |
| `GET /posts/:id/comments` | `FeedPost[]` | same | `GetPostCommentsData` |
| `POST /posts` | `FeedPost` | same | `CreatePostData` |
| `GET /users/:username` (public profile) | `{ user, pinnedPost? }` | `src/common/dto/user.dto.ts` (`UserDto`) + post | `types/api.ts` (`PublicProfileData`) |
| `PATCH /users/me/profile` etc. | `{ user }` | `UserDto` | consumed as `data.user` |
| `GET /auth/me` | `{ user }` | `UserDto` | consumed as `data.user` |
| `GET /search` (type=bookmarks) | `SearchBookmarkItem[]` | search controller maps to post DTO | `SearchBookmarkItem` |
| `GET /notifications` | list with custom DTO | `notification.dto.ts` | `NotificationDto` etc. |
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
