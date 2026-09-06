# Admin experience: web, iOS, MCP, CLI, and MARV

## Implemented architecture

The admin panel uses the tool layer behind MCP directly inside the API. It does not
open a second MCP/OAuth connection. `tools/mcp/src/tools.mjs` remains the shared read
registry for the CLI, desktop MCP, hosted MCP, and admin MARV. The same HTTP API guards
and redaction run underneath. No additional protocol, server, API key, or iOS login
is required beyond the existing MARV configuration and authenticated web handoff.

`tools/mcp/src/admin-catalog.mjs` owns the feature catalog used by web navigation,
iOS navigation, and the `admin_capabilities` tool. Run `npm run check:admin-coverage`
to check the [complete guarded endpoint inventory](admin-endpoints.md). The inventory
accounts for every guarded controller operation; catalog presence does not imply
that every operation is an AI tool.

Admin MARV has its own private workspace and database history. It never shares
conversation context or admin functions with public replies, member DMs, or catch-up.
Admin usage has its own `admin_console` source in the existing usage/cost accounting.
It uses the configured Regular model, up to 16 tool calls and 4 proposals per question,
a 210-second model deadline, and 30 questions per administrator per hour. It does
not debit member chat credits. Reading the workspace does not automatically call AI.

## Feature coverage

| Area | Web | iOS | MARV / MCP / CLI |
| --- | --- | --- | --- |
| Business briefing, queue health, failed scheduled posts, webhook backlog | Ask MARV; Jobs | Authenticated Ask MARV handoff; Jobs handoff | Existing founder briefing, operations health, queue health |
| Growth, retention, activity, membership, content, community, AI and coins | Analytics; Ask MARV | Native analytics plus full web tools | Existing analytics areas and metric definitions |
| Referral attribution | Analytics and member details | Native analytics plus full web tools | Referral analytics and member referrals |
| Member search, profiles, account diagnostics, grants | Users | Users handoff | Search/profile/diagnostics/grant reads; changes in Users editor |
| Bans, profile edits, avatar/banner, coins, organizations, page conversion/creation, operators, email unverification | Users and member details | Users handoff | Cataloged; dedicated controls |
| Sensitive-contact reveal | Member details | Users handoff | Intentionally not exposed to AI |
| Impersonation | Log in as user | Existing native flow plus web access | Direct admin control only; impersonated/switched sessions cannot use admin MARV |
| Verification | List, approve, reject | Handoff | New workspace read; MARV proposes approve/reject |
| Feedback | List, filters, details, status, internal note | Existing native read; full web controls | Existing read; MARV proposes status/note changes |
| Reports | List, filters, details, status, internal note | Existing native read; full web controls | Existing read; MARV proposes status/note changes. Status changes do not ban/remove anything |
| Media | List/detail/reference inspection, individual/bulk deletion | Handoff | Cataloged; visual/destructive workflow remains in editor |
| Announcements | Draft/edit/publish/unpublish/archive/reset | Existing native editor plus web tools | New workspace read; MARV proposes create/edit/publish/unpublish/archive; reset remains manual |
| Newsletters | Draft, audience filters/count, preview, test send, duplicate, schedule/unschedule/send | Newly exposed handoff | Existing read; MARV proposes complete draft creation and unscheduled-draft edits; delivery stays in editor |
| Search history | Search and per-member searches | Existing native search plus full web tools | New bounded global workspace read; member history via editor |
| Post limits and automatic verification | Site settings and recruiter preview/apply | Handoff | New settings read; changes stay in editor |
| Maintenance/backfills/queue inspection | Jobs | Handoff | Queue/health and daily-content reads; cleanup/backfills/coin reset remain manual |
| Daily quote and dictionary word | Jobs | Jobs handoff | New daily-content read; refresh remains manual |
| Email samples | Site settings | Site settings handoff | Dedicated send controls |
| Test push | Push notifications | Existing native push plus web tools | Direct controls, self-targeted |
| MARV models, prices, global switch, credits, disabled members, context cards, usage/cost | MARV settings | Handoff | New config/user/usage/cost reads; MARV proposes member credits/disabled changes. Global config and context regeneration stay manual |
| Weekly introductions | Intros | Newly exposed handoff | New latest-brief read; regeneration remains in Intros; no automatic messages |
| Referral Pilot | Membership/earnings/settlement | Handoff | New earnings read; membership and payout settlement remain manual |
| Crews | No dedicated admin editor | Catalog explanation | New bounded crew inspection; transfer/disband API exists and is explicitly cataloged as lacking an editor |
| Taxonomy backfill | API-only `POST /taxonomy/backfill`; now uses the shared own-admin guard | No dedicated screen | Cataloged under maintenance; not an AI action |
| Contextual admin controls | Post editing/ranking details; group creation/settings/pins/moderators; crew settings on their entity screens | Existing post/group/crew flows, subject to their domain permissions | Explicitly cataloged; no general private-content mutation tool |
| Deployment health/configuration | Admin-only API and infrastructure provider | Catalog explanation | Not exposed to AI; infrastructure access remains separate |
| Local drafts/decision log | Not synchronized | Explicitly marked desktop-only | Existing four local-file CLI/desktop tools; hosted MCP/MARV cannot read these files |

The transport catalogs now expose 22 desktop/CLI tools and 18 hosted read tools.
`admin_workspace` covers verification, announcements, searches, site settings,
MARV config/users/usage/cost, intros, affiliates, daily content, and crews. All list
results are bounded or explicitly marked truncated. MCP remains read-only; the 12
proposal operations belong only to the authenticated in-product admin assistant.

## Action execution and limits

MARV can prepare a proposal; it cannot approve it. Each proposal stores the exact
validated input, current target snapshot, owner, creation time, and ten-minute
expiry. Web renders the current item and changes as text, with explicit Apply and
Cancel controls. iOS opens that same workspace through authenticated web handoff.

Confirmation rechecks the caller's own admin session, ownership, expiry, input schema,
and target snapshot. It atomically claims the proposal before invoking the existing
admin HTTP endpoint. That endpoint keeps its existing business rules and side effects.
The receipt records success, stale state, cancellation, expiry, failure, or uncertainty.
An uncertain write is never automatically retried. The snapshot check is a preflight;
it is not an atomic compare-and-swap against edits made through other admin surfaces.
If the process stops during execution, use the linked editor to verify the outcome.

The database keeps private question/answer history and proposal receipts. The UI
shows the latest 30 turns. HTTP supplies initial/recovery state; `admin:updated`
invalidations synchronize the owner's tabs. Native navigation fetches the catalog
on activation. Normal admin editors retain their existing realtime behavior.
The provider may store Responses as in the existing MARV tool loop; session cookies
never appear in model input, logs, saved conversation history, or proposal records.

Newsletter sending and scheduling continue to require `NEWSLETTER_POSTAL_ADDRESS`.
A draft is not an approved send. No newsletter, push, payout, ban, or production
mutation was executed as part of this implementation.

## Review findings and next priorities

Implemented:

- Replace the empty desktop admin landing pane with a useful private MARV workspace.
- Centralize the feature list instead of keeping web/iOS/MCP discovery independently.
- Expose missing iOS newsletter/intros destinations and full controls from partial native views.
- Separate operational questions from MARV configuration; keep regular member chats unprivileged.
- Replace the legacy taxonomy backfill permission check with the shared own-admin guard.
- Expand read coverage beyond metrics/support and make unsupported actions explicit.
- Persist proposals and receipts, guard repeated writes, and surface stale/uncertain results.
- Reuse controller Zod schemas and the existing newsletter write normalization when creating drafts.

Further improvements identified, intentionally not represented as implemented features:

1. Add atomic version preconditions and idempotency keys to the underlying mutation APIs
   before expanding assistant execution to high-impact financial/destructive/bulk actions.
2. Consolidate support/report/verification queue counts into a deterministic attention view
   with direct filtered links. Do not spend AI tokens merely to show queue counts.
3. Add an actual crew admin editor if transfer/disband workflows are used regularly.
4. Extend persistent decision/draft artifacts to a shared server store only if cross-device
   access is wanted; do not silently ingest personal CLI files.
5. Native report/feedback screens still provide a smaller control set than web. They now
   expose the full web workflow. Building duplicated native editors should be usage-driven.
6. Expand admin realtime invalidations across all editors, including drafts/settings/jobs;
   the existing event contract initially covered only feedback/reports/verification.
7. Add conversation pagination/archive and an audit search screen if 30 recent turns is
   insufficient for daily admin work. Receipts already persist beyond the UI window.

This review combines source inventory and verification of the signed-out admin boundary.
A signed-in local browser walkthrough needs an authenticated local admin session. No
production state is changed to manufacture test cases.

## Deployment and verification

Deploy API first. The additive `20260906040000_admin_assistant` migration adds the
private turn/proposal tables and `MarvinSource.admin_console`. It has no data backfill
or destructive statements. Generate Prisma and contracts using the normal build flow.
Then deploy web and ship iOS. Existing MCP installation is reused through root postinstall.
No new production environment variables are introduced.

Run the engineering-policy gates, `npm run mcp:test`, and
`npm run check:admin-coverage`. For an authenticated acceptance test after deployment:
open Admin, ask a read-only question, verify sources/cost accounting, create a disposable
draft proposal, inspect it, cancel it, and confirm that the draft was not written.
Then test a separately approved disposable draft and verify the same receipt in another tab.
Do not use a live newsletter send as a connectivity test.

OpenAI tool-loop reference: [Function calling](https://developers.openai.com/api/docs/guides/function-calling).

Verification completed locally (September 6, 2026): API lint/typecheck/build and
183 suites / 2,058 tests; 26 MCP/CLI transport tests; iOS format/lint/build and
715 tests; web lint/build with 130 suites / 1,073 tests, followed by five focused
workspace lifecycle/component tests including the final proposal-button case.
All 22 anonymous hydration routes passed, including `/admin` and `/admin/assistant`.
The compiled API bridge also loaded the actual ESM registry and converted all
18 read schemas and 12 proposal schemas. Existing web lint/build/test-environment
warnings remain; changed-file lint is clean. Database migration deployment and a
signed-in live MARV acceptance test were not performed.

## Attention, activation, and member MARV actions (September 6)

- **Attention inbox** (`/admin/attention`) combines pending reports, verification, feedback,
  aging payment webhook events, scheduled-post failures, and public conversations with no
  human reply in the last 14 days. Counts cover the full query; the oldest eight conversations
  are previews. It reuses the operations health implementation and links to the existing editors.
- **Member activation** (`/admin/activation`) follows 30/90-day signup cohorts through recorded
  verification, a public post/reply after verification, and activity on a later UTC day. Totals
  cover the complete cohort; member rows filter by highest milestone and paginate independently.
  This intentionally differs from the older analytics activation metric. Small/recent cohorts,
  deleted content, and verification-date changes are explained in the interface.
- Both appear automatically in the shared catalog and the iOS authenticated admin handoff.
  MCP and CLI expose `admin_workspace` → `attention` and `member_activation`.
  CLI examples: `moh workspace attention` and `moh activation --days 90 --stage verified`.
- **Personal actions** live under **Actions** in the member's private MARV chat, on web and
  natively on iOS. MARV can prepare a public-post bookmark, a notification-preference change,
  or a plain-text post/check-in draft. The user reviews and applies individual proposals;
  drafts can be copied into the normal composer and never publish or record a check-in.
  These tools are absent from public replies, Catch Up generation, admin MARV, and hosted MCP.
- Personal proposals persist privately, expire after 24 hours, and show the latest 30 actions.
  A database claim prevents duplicate confirmation. Writes reuse BookmarksService and
  NotificationPreferencesService. Notification changes compare the reviewed values before
  applying; this preflight is not an atomic compare-and-set against concurrent Settings writes.
  Failed or interrupted writes are never retried automatically. An interrupted `executing`
  receipt requires checking the actual Bookmarks/Settings state.
- **Participation suggestions** are separate from the shared summary cache and scoped to the
  viewer. They use recent public human posts, follows, and shared profile interests, exclude
  both directions of blocking and posts already replied to, and diversify authors. Selection
  examines at most 60 recent posts and 1,000 follows; no private conversations are used.
  This secondary browsing surface refreshes on open/activation rather than continuously
  reranking underneath a reader. It does not spend AI credits or send invitations.
- Catch Up uses a stable desktop/mobile viewport-bounded panel and one large iOS detent.
  Regeneration keeps the previous summary visible, with progress and failure feedback.
  Web requests discard stale results after changing the focal post, options, or identity.
- Ask MARV and web Catch Up render Markdown through one Vue-node renderer: formatting,
  lists, links, tables, and code. Raw HTML is text, unsafe link schemes are rejected, and
  Markdown images do not load tracking resources. The parser uses the already-installed
  `marked` version; it is now an explicit dependency.
- The web account menu anchors its bottom edge eight pixels above the clicked profile
  card. Account rows can load without moving that edge; available height is capped with
  internal scrolling, and resize/scroll tracking ends when the menu closes.

Deployment order: apply `20260906050000_marvin_personal_actions` with the API deployment,
then deploy web and release iOS. No environment variables, PostHog integration, or new paid
service is required. Never apply this migration to production as a validation step.

Local verification for this addition: API lint/typecheck/build/module graph and 187 suites /
2,072 tests passed; all 27 MCP/CLI tests passed. iOS format, strict lint, build, 715 tests,
and static checks passed. Web lint, typecheck, contract validation, build, and 134 suites /
1,082 tests passed, as did all 24 anonymous hydration routes. Existing lint/build warnings
remain, including unavailable local Sentry source-map upload. Production data, paid AI
calls, and migration deployment were not exercised.
Authenticated browser fixtures also verified Markdown, both admin panels, delayed account
loading, menu anchoring through an open-window resize, and Catch Up participation rendering.
The final class-only mobile mode/balance spacing adjustment was linted and previewed against
the source classes at 390px and 320px widths after the build, without repeating unaffected gates.
