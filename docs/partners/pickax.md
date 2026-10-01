# Connect Pickax to Men of Hunger

Men of Hunger (MOH) is where members create. Pickax can connect an account and read permitted public information. MOH alone creates linked outward copies. **Never create a Pickax copy in response to an ordinary MOH content webhook.** There are no partner endpoints to publish, reply, react, follow, upload, or delete MOH content.

This is the launch integration contract. Access is provisioned by MOH; production enablement is separate from shipping this guide. Reciprocal Pickax OAuth and remote removal stay disabled until both teams validate Pickax's capabilities with test accounts.

## Quickstart

1. Ask the MOH team for a test client ID, client secret, webhook secret, and the test issuer. Supply exact HTTPS callback/logout URLs and a public HTTPS webhook URL. Test and production use different clients. Keep secrets on your server.
2. Discover `${issuer}/.well-known/openid-configuration`. The production issuer is the API origin followed by `/oauth`; use the assigned issuer rather than guessing a host. The resource identifier is the same origin followed by `/v1/partner`.
3. Redirect the member to the discovered authorization endpoint with `response_type=code`, your registered `redirect_uri`, `client_id`, `scope`, unpredictable `state`, `nonce`, and PKCE `code_challenge` with `code_challenge_method=S256`. Use `prompt=consent` when requesting offline access. Store state, nonce, and the verifier in a short-lived server-side session bound to the initiating browser. Never put the verifier or client secret in a browser URL.
4. The member signs in or completes signup, explicitly selects their person/page, and approves scopes. Validate state on return. A denial ends this attempt; show a retry button without automatically restarting authorization.
5. Exchange the code at the discovered token endpoint using HTTP Basic client authentication, the exact redirect URI and PKCE verifier. **Include `resource=<API origin>/v1/partner` in code exchange and refresh requests for partner reads.** Validate ID tokens with a maintained OIDC library, including issuer, audience, signature, expiry, and nonce. Download the [runnable TypeScript example](/developers/client.mts.txt) and its [setup instructions](/developers/example-readme.txt).
6. Call `GET <resource>/me` with `Authorization: Bearer <access_token>`. Store its immutable `id` as the selected MOH account. Fetch `GET <resource>/users/{username}/posts`, then `GET <resource>/posts/{id}`. Treat usernames as display values, not identity keys.
7. Verify webhook signatures on raw bytes, persist event IDs, then acknowledge quickly with a 2xx response. Process asynchronously.
8. To disconnect read access, use the discovered revocation endpoint with client authentication and the refresh token. Members can also revoke in MOH's Connected apps settings. Delete cached personal/social data when access ends. Retain only identifiers needed to handle outstanding removals or required records.

Example identity response:

```json
{"data":{"id":"moh_account_id","username":"example","name":"Example","bio":null,"avatarUrl":null,"canonicalUrl":"https://menofhunger.com/u/example","accountKind":"person","createdAt":"2026-09-30T12:00:00.000Z","counts":{"followers":4,"following":8}}}
```

## Identity, pages, and consent

OIDC `sub` identifies the **human who authenticated**. `/me.data.id` identifies the **selected resource account**, which can be a page. Never substitute one for the other. Page-only authorization can omit `openid profile` and use OAuth without requesting the human's profile. When using OIDC, use UserInfo for human profile claims. Resource tokens are audience-bound to the partner API and are not UserInfo tokens; request a separate token without `resource` if UserInfo is needed.

The initiating operator's authority is checked at consent, code redemption, refresh, and every resource access. A removed operator's grant stops working; a current operator must reauthorize. Other operators never receive the saved external credentials. Connecting is free. Outward publishing requires current MOH verification; Premium alone does not qualify.

| Scope | Access |
| --- | --- |
| `openid` | Human OIDC sign-in identity |
| `profile` | Human public OIDC profile claims |
| `offline_access` | Refresh token, subject to consent |
| `account:read` | Selected account and public profiles |
| `verification:read` | Selected account's current verification category and timestamp |
| `content:read` | Public posts, articles, comments and content search |
| `social:read` | Selected account's followers/following |
| `webhooks:read` | Subscribed events, additionally gated by the event's read scope |

Effective scopes are the intersection of the application's registered scopes and the member's consent. Verification status is `none`, `manual`, or `identity`; it is an MOH status, not identity evidence or a guarantee about a member's conduct. Evidence and documents are never included.

## Public resource API

All paths below are relative to `/v1/partner`.

| Method and path | Scope |
| --- | --- |
| `GET /me`, `GET /users/{username}` | `account:read` |
| `GET /me/verification` | `verification:read` |
| `GET /me/followers`, `GET /me/following` | `social:read` |
| `GET /users/{username}/posts`, `GET /users/{username}/articles` | `content:read` |
| `GET /posts/{id}`, `GET /articles/{id}` | `content:read` |
| `GET /posts/{id}/comments`, `GET /articles/{id}/comments` | `content:read` |
| `GET /search?q=example&type=users` | `account:read` |
| `GET /search?q=example&type=posts` or `type=articles` | `content:read` |
| `POST /connection/continue` | `account:read`, approved Pickax client only |

Single responses use `{ data }`; lists use `{ data: [], pagination: { nextCursor } }`. Pass `cursor` unchanged. Default `limit` is 20; maximum 100, or 50 for search. A null next cursor ends the list. There is no bulk export. An inaccessible resource returns 404. Public reads do not record views or mark notifications read.

Objects contain immutable IDs, canonical MOH URLs, `status: "published"`, timestamps, allowlisted author profiles and public media URLs/alt text. Post bodies are plain text; article bodies are allowlisted HTML. Article comments include `articleId` and `parentId`. Missing optional fields and explicit nulls must be handled. Do not infer visibility, verification evidence, email, or operator identity from omitted fields.

The public ceiling applies even when the member can see more inside MOH. Drafts, scheduled content, restricted content, groups, Board shells, quoted/reposted objects, blocked/banned accounts, deleted content, messages and personal notifications are excluded. Counts and pagination are filtered for the connected account. The `engagement` object reports visible boosts/comments and recorded distinct signed-in viewers (`uniqueViewers`), plus reaction records on articles. It excludes blocked/banned accounts; it is not an audience or reach estimate. Advanced analytics and reach are not part of this launch API.

The production-accessible reference is at the assigned API origin's `/partner/docs`; machine-readable OpenAPI is `/partner/openapi.json`. It exposes partner routes only, independently of internal/admin documentation. OAuth responses and errors follow OAuth/OIDC standards; resource errors use MOH's `{ meta: { status, errors: [{ code, message, reason }], requestId? } }` envelope.

## Token and retry rules

Authorization codes expire after five minutes and are single-use. Access tokens are opaque and expire after 15 minutes. Refresh tokens rotate, expire after 30 days of inactivity, and cannot extend a grant beyond 180 days.

Serialize refresh operations per grant in your shared store. For the same authenticated client, an identical refresh request replayed within ten seconds returns the original encrypted-cached result. Concurrent work still in progress may return 429 with `Retry-After: 1`. Retry the **identical** request after waiting. Reuse after the window revokes the token family; obtain new consent. Changed scope/resource parameters are not an identical replay. Persist each successful rotated token atomically before releasing your refresh lock. Never run independent refreshes in two workers.

Supported first-party connection mutations accept `Idempotency-Key` for 24 hours. A completed identical request returns the original result; the same key with a different payload returns 409. This is separate from OAuth code redemption and refresh. It does not authorize partner content writes.

| Limit per minute | Default | Pickax launch |
| --- | ---: | ---: |
| Reads per client/account | 120 | 300 |
| Reads per client | 1,200 | 6,000 |
| Search per client/account | 30 | 30 |
| Token calls per client | 600 | 600 |
| Refresh calls per grant | 60 | 60 |

These are adjustable launch allocations, shared across API instances. Resource responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds). The headers describe the tightest checked budget. A 429 includes `Retry-After` in seconds. Add jitter and honor it. Partner requests do not consume first-party posting quotas. UserInfo shares the client/account read allocation. Authenticated introspection and revocation share a separate 600 calls/client/minute allocation and can inspect or revoke only that client’s tokens. Unauthenticated abuse has separate IP protection.

## Webhooks

MOH administrators configure destinations and subscriptions initially. Supported event names: `profile.updated`, `verification.updated`, `post.updated`, `post.removed`, `article.updated`, `article.removed`, `comment.updated`, `comment.removed`, `mention.created`, `follow.created`, `follow.removed`, `connection.revoked`.

Events concern connected accounts, not a global firehose. Each attempt rechecks consent, current authority and public visibility, then builds a fresh allowlisted payload. Removal events contain identifiers, not deleted content. Revocation immediately stops ordinary delivery; one minimal terminal revocation event is allowed. Store deletions as tombstones, and discard outdated versions.

```json
{"id":"event_id","type":"post.updated","origin":"menofhunger","createdAt":"2026-09-30T12:00:00.000Z","version":"123","accountId":"moh_account_id","resource":{"kind":"post","id":"post_id"},"data":{"id":"post_id"}}
```

`data` above is abbreviated; content events carry the current public object. Version is a decimal string, compared numerically per account/resource; gaps are normal. A webhook is a notification to update your cached view, **not a publishing instruction**.

`X-MOH-Signature: t=<Unix seconds>,v1=<hex HMAC>` signs the raw UTF-8 string `<timestamp>.<raw body>` using HMAC-SHA256. `X-MOH-Event-Id` must match the signed body's `id`. Accept any valid `v1` during secret rotation; compare in constant time. Reject timestamps more than five minutes away. Deduplicate event IDs durably; retries are signed with a fresh timestamp. Treat lower versions as stale. Persist the event before acknowledging.

Delivery is at least once, with a ten-second request timeout and exponential retries bounded to 72 hours. Diagnostics are retained for 30 days. Redirects and private-network destinations are rejected, and DNS is pinned for each attempt. Ask MOH for replay or delivery inspection; keep your handler idempotent.

## Reciprocal Pickax connection

Read access and outward sharing are independent permissions. A successful MOH OAuth callback does not give MOH a Pickax token.

After MOH consent on Pickax, call `POST /connection/continue` with `{"externalAccountId":"<authenticated immutable Pickax ID>"}` and your partner bearer token. Present the returned URL as an explicit next step. The continuation expires after ten minutes and is one-time. MOH authenticates the original operator and asks Pickax to grant outward publishing permission. MOH confirms the returned account through Pickax `/me`; mismatched IDs cannot finalize the pairing. Never send usernames or emails as account IDs.

From MOH, the member can authorize outward sharing first. Register a fixed HTTPS `authorizationStartUrl` with MOH: the finish screen links there explicitly for the remaining read authorization. Pickax must start a fresh, browser-bound MOH authorization request at that URL. Afterward, `/connection/continue` recognizes a matching active outward pairing authorized by the same operator and returns the final settings URL, avoiding a repeated authorization loop. Read access remains separately disconnected until that step completes. Show both statuses. Denial ends that direction; retry only the incomplete step. Do not redirect endlessly or silently reconnect a declined direction.

Each person/page has at most one active Pickax and one active X pairing; each external account belongs to at most one MOH account. Reauthorization renews the same identity. Switching requires explicit disconnect. Disconnecting Pickax in MOH stops outward sharing and revokes Pickax read grants for that MOH account. Revoking read access from Connected apps stops that read direction. Disconnect does not delete historical copies. Old deliveries never migrate to a new connection identity.

### Pickax capabilities to validate together

| Capability | MOH implementation | Pickax dependency |
| --- | --- | --- |
| OAuth/OIDC sign-in and public reads | Behind partner access switch | Register test/prod clients and integrate consent |
| Signed webhooks | Independent switch | Public receiver, signature/deduplication handling |
| Existing credential-based outward sharing | Preserved | Existing create/update contract |
| Reciprocal OAuth | Adapter and continuation behind switch | Authorization, refresh, authoritative `/me`, immutable IDs |
| Remote removal | Adapter behind switch | Confirm delete/unpublish response and idempotency |
| Inbound content writes | Unavailable by design | Do not implement an inbound publishing loop |

The proposed Pickax OAuth adapter uses `${PICKAX_OAUTH_ISSUER}/authorize`, `/token`, `/revoke` and `/me`; these are **contract fixtures to agree with Pickax, not claims about currently deployed Pickax routes**. `/token` uses confidential-client Basic authentication, authorization code with PKCE, and refresh grants. `/me` must return `{ data: { id, username } }`. Tokens require `access_token`, `token_type: "Bearer"`, `expires_in`, and `refresh_token`. Validate these together before enabling.

Require stable remote create/update IDs, canonical URLs, status and timestamps. Agree idempotency retention/replay behavior before permitting ambiguous create retries. Require deletion/unpublishing and refresh/revocation contracts. Until confirmed, uncertain creates and unsupported removals remain visible as needing attention; MOH never claims a remote deletion succeeded without confirmation.

## Outward content and X allowances

Members select destinations on each MOH publication, including scheduled publications. Connecting never opts in. MOH publishes first; external failures do not roll it back. Only eligible public top-level posts/articles fan out. Replies, reposts, quotes, groups and unsupported kinds remain in MOH.

Pickax defaults to a plain-text excerpt and canonical MOH link. Full copies are explicit and include attribution and the original link. Uploaded images preserve alt text in Pickax's attachment name field; that field is not a guarantee of accessible alt rendering on Pickax. Unsupported videos/polls use link sharing. Article HTML supports paragraphs, h2/h3, lists, quotes, bold/italic/underline/strike, code, rules, breaks, safe HTTP(S) links and images. YouTube embeds become links; scripts, iframes, style and arbitrary attributes are not emitted. A full copy that exceeds provider limits needs a different sharing choice; original user links are not silently removed.

MOH edits update the linked Pickax copy when supported. X edits do not create replacements. Deletion, unpublishing or leaving public visibility cancels pending delivery and requests remote removal. Remotely deleted content must not be recreated automatically. Inbound provider events may report connection/delivery state, never mutate MOH content.

Verified accounts receive 50 X posts per UTC calendar month, of which 3 may contain links. Verified Premium/Premium+ accounts receive 300 and 20. Each page has its own shared operator allowance using its effective entitlement. A linked post consumes both a total and link slot. Attribution URLs count. Scheduled posts use the month actually sent. Upgrades expand limits without resetting usage; downgrades preserve usage; reconnecting cannot reset it. Uncertain deliveries reserve allowance, confirmed failures release it, and deletion of a successful post does not refund it. Reset is midnight UTC on the first; no rollover.
