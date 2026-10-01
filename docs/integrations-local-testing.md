# Integrations: local testing and implementation status

October 1, 2026. X implementation and local validation update. LinkedIn publishing and optional Rumble live data remain separate follow-ups. Do not push or deploy until JPM has tested and approved the local result. Existing dev servers remain user-owned; no credentials or `.env` files were changed. The five new migrations have been applied only to the local `menofhunger` database at `localhost:5432`.

## What is implemented

| Area | Local implementation |
| --- | --- |
| Shared budgets | Exact microdollar ledger; Premium $8 regular, Premium+ $8 regular/$10 expensive; $2 funded pooled reserve model; company/daily/provider caps; removal headroom; 300 paid X publications and 50 verified nonpaid publications with separate acquisition funding |
| Durable accounting | Exclusive operation claims, uncertain holds, historical backfill, external-identity/account-switch protection, send-month reservations, legacy rollout accounting, explicit audited administrator reconciliation |
| X publishing | Text/photos/links and native Articles; explicit post-detail editor on both clients for threads, compatible polls, owned video/GIF uploads, replies, account-approved quotes/long posts/edits. Every part counts, maximum spend is reserved first, each acknowledged ID is saved, partial threads require review, and source/connection/control/lease checks run before subsequent calls. |
| Profile editing | Public Rumble, LinkedIn and YouTube URL fields on API/iOS/web, independent of publishing credentials; canonical URL validation; typed realtime updates and explicit field clearing |
| Profile previews | Website, Pickax, Rumble, LinkedIn, YouTube and state metadata previews; rich X banner/avatar/bio/counts/verification/website layout; conditional private relationship/Message on X data; no Grok or mutual-follower crawling |
| Interaction | Profile-header triggers only; web hover/focus intent and close grace, real links, keyboard/Escape, one active card, stale-response cancellation, viewport placement; native Preview context action/sheet/popover and ordinary tap preserved |
| State previews | State vector, visible member count, at most six avatars plus remainder, block-filtered count/sample, existing directory destination |
| Caching | Redis hot cache plus durable normalized PostgreSQL snapshots, shared by immutable identity for 24 hours, private viewer-context cache for 15 minutes, distributed locks, daily cold-read limits, short negative caches, expiry fallback; profile-page metadata normally fresh for 24 hours |
| Author metrics | Owner-only post-detail panel on both clients; request on opening, latest 20 remote copies eligible for fresh reads, 24-hour public snapshot reuse, $1 analytics sublimit within the $8 pool |
| News experiment | Disabled-by-default seven-day shared digest; maximum 14 refreshes, two/day, five source-linked items, bounded per-request reservation and lifetime spend, cached Explore cards on both clients |
| Administration | Native admin screen and web `/admin/integrations`: company/day/X/reserve ceilings, pause switch, active alerts, recent changes, pending charges and explicit reconciliation. Revision checks and audit history protect concurrent edits. |
| Performance | Monthly/lifetime ledger sums execute in PostgreSQL; only aggregate scalars return to the request process. Company locking preserves atomic caps. |
| Operational alerts | Five-minute queued monitor; 80%/100% spend thresholds, Redis failure, held funds, repeated uncertain outcomes and reconciled price overruns. Durable alerts plus deduplicated Sentry/log notifications; no Slack/email delivery added. |

Design source: [approved profile cards and flow studies](integrations-and-profile-previews-plan.md#design-handoff).

## Start local review

1. Open [your local web profile](http://localhost:3000/u/jpmcglone). Hover or keyboard-focus **Virginia**. The card should show the local member count and avatars; Tab enters its action and Escape returns focus to the link. No request happens before the 300 ms intent delay.
2. In **Edit profile**, try a website and public Rumble/LinkedIn/YouTube profile/channel URL. Save, check the displayed link and preview, then clear it to verify explicit clearing. Pickax uses public-page metadata, so a blocked site should show a useful fallback and working external link.
3. In iOS, use the **Local** API environment. The simulator was built against local for review. On a profile, long-press the metadata link and choose **Preview**; a normal tap should retain its ordinary destination. Check compact sheets and an iPad/regular-width popover.
4. Test the same profile with another local account, including a blocked member. Counts and samples must agree; there must never be more than six avatars.
5. In integrations settings and the composer, verify existing destinations remain explicit opt-ins. Native publishing must explain incompatible content rather than silently replacing it with a link.

Paid X enrichment, new-budget rollout, Articles, private DM context and news remain **off by default**. With those switches off, the rich X card falls back to View on X, unavailable metrics remain unavailable, and the news card stays hidden. This is intentional; merely opening the local site must not start unknown-cost provider requests.

## Charge-free fixture review

- Web: from `menofhunger-www`, run `node scripts/check-integration-browser.mjs` for the automated browser checks, or append `--serve` to open the fixture gallery for up to 15 minutes. It starts its own loopback server and closes it afterward. Existing development servers are untouched. The gallery imports the real preview, publishing and admin components; surrounding shell/avatar/state primitives use lightweight fixture stand-ins.
- Native: launch a Debug build with `--integration-fixtures`. This replaces the app root with a synthetic gallery and intercepts API responses before networking. Long-press an X row and choose Preview; compare available, no-DM, expired and unavailable states. Test thread editing/queueing and pending-charge review. Remove the argument to return to the normal local app. No session token is needed or modified.
- Synthetic responses live in `test/fixtures/integration-provider.json` (API), `tests/fixtures/integration-provider.json` (web), and the native `App/Resources/integration-provider.json`. They are not evidence of live provider entitlement or actual billing.
- Admin Figma frames: [spending controls](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1057-389), [charge review](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1057-416).

## Controlled X test configuration

Only set these in a deliberately chosen local/test environment after checking the actual developer console. `env.example` documents the settings; no live values were installed by this implementation.

- `INTEGRATION_BUDGET_ENABLED`, `INTEGRATION_X_PRICE_VERSION`, company monthly/daily ceilings, X provider ceiling, funded reserve, acquisition funding and removal headroom. Empty/zero ceilings prevent spending. Reference catalog version is `x-reference-2026-10-01`; that string is a confirmation gate, not automatic evidence of current billing.
- `X_ADVANCED_ENABLED`, `X_ADVANCED_ACCOUNT_IDS`, `X_ADVANCED_PRICE_VERSION`, `X_ADVANCED_POST_MAX_MICROS`, `X_ADVANCED_MEDIA_MAX_MICROS`: advanced publishing gate and verified conservative totals. A media maximum must cover initialize, every append, finalize, up to ten bounded status checks and any metadata request. Separate `X_QUOTE_ENTERPRISE_ACCOUNT_IDS`, `X_LONG_TEXT_ACCOUNT_IDS`, and `X_EDIT_ACCOUNT_IDS` gates reflect account-specific access. Blank pricing is never free.
- `X_IMAGE_UPLOAD_MAX_MICROS`: conservative confirmed per-image upload maximum. Unknown/blank is not free. Alt-text requests are reserved separately.
- `X_PROFILE_PREVIEW_ENABLED`: public X snapshots. A cold request currently needs a connected viewer's authorized X token. Other eligible signed-in viewers can reuse the funded public snapshot. A manually saved X handle is resolved before its immutable-ID cache can be reused.
- `X_PROFILE_CONTEXT_ENABLED`: separate private relationship/DM lookup. Enable only after testing `receives_your_dm` semantics and the compose-message handoff with the actual account. No inbox scope is requested.
- `X_ARTICLE_ENABLED`, `X_ARTICLE_ACCOUNT_IDS`, `X_ARTICLE_MAX_MICROS`, `X_ARTICLE_PRICE_VERSION`, `X_ARTICLE_BUCKET`: allowlist the immutable X test-account ID; confirm a conservative total for draft and publish, including any link treatment. Media costs are additional. Unsupported rich-text nodes return an explicit incompatibility. An interrupted draft/publish retains its ID and requires review; it is not automatically resumed or recreated.
- `X_NEWS_ENABLED`, `X_NEWS_PILOT_START`, `X_NEWS_ACCOUNT_USER_ID`, `X_NEWS_QUERY`, `X_NEWS_REQUEST_MAX_MICROS`, `X_NEWS_PRICE_VERSION`: fixed seven-day pilot, one bounded search per half-day slot. Cap is the smaller of $10 and 10% of funded reserve. Explore only reads the shared digest; it does not initiate the vendor fetch.

Never use a real publish to verify the UI casually. Fixture tests cover budget failures, concurrency and ambiguous outcomes without provider charges. A real outbound test is an external publication and should use a designated test account and deliberate destination selection.

## Still unimplemented or requiring acceptance

These are not hidden behind a completed/ready label:

- **LinkedIn publishing:** public links and generic previews exist. OAuth connection, publishing adapters, format approval, organization-role validation and composer delivery support do not yet exist. Approved app products/scopes are still needed for a credible integration acceptance test. [LinkedIn permissions and versioned Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).
- **Live X acceptance:** the advanced adapter and review UI are implemented and fixture-tested. Real account entitlements and maximum request costs are not asserted. Quotes require confirmed Enterprise access. New formats are reviewed from an already-published MOH post; the ordinary composer/scheduler continues its existing simpler crosspost path. There is no automatic splitting or truncation. Native edits of multi-part threads, mixed moving media, Giphy-origin attachments, image-choice polls, and animated-media alt text remain explicit incompatibilities. Long-post maximum is 25,000 characters; a thread has at most 20 reviewed parts.
- **Parser:** API, web and native use pinned official twitter-text 3.1.0. All 22 upstream discounted-emoji weighted test vectors pass in each runtime. Cost detection is deliberately more conservative for internationalized/bare-domain links. `node scripts/sync-x-text.mjs --check` checks generated client bundles and their bundled licenses.
- **Pickax expansion:** its existing text/link/photo/Article adapters remain in use. New media types, replies/polls and reciprocal OAuth/remote-delete acceptance have not been established against the deployed partner service. No unsupported endpoint was invented.
- **Optional operations follow-ups:** automated invoice import/matching and a news engagement/cost dashboard are not implemented. Manual charge reconciliation, spending controls, indexed aggregate accounting and operational alerts are implemented. Sentry delivery depends on the existing monitoring configuration; alert records remain available in admin regardless.
- **YouTube:** public channel links and existing public video metadata are reused. No new Data API key calls or quota ledger were added. Project-specific quota tracking is required if those API calls are introduced.
- **Rumble:** public user/channel links and metadata previews exist. Creator livestream polling and video publishing remain outside this checkpoint; the plan labels live data optional and publishing unverified.
- **Provider acceptance:** real X publishing and the external DM handoff still need a designated test account with confirmed pricing. Full VoiceOver auditing has not been performed; semantic labels, keyboard navigation and native preview actions are implemented.


## Deliberate implementation differences

- State summaries use the visibility-filtered database query on demand rather than a five-minute shared cache, avoiding cross-viewer block/privacy leakage.
- Redis is a hot cache; fresh durable public snapshots survive its loss without another paid read. Expired snapshots are never served or refreshed automatically. Redis failure prevents paid refreshes. Database snapshots contain no tokens, relationships or DM permissions; private context remains viewer-scoped in Redis. Known deletion/protection changes invalidate snapshots, and a bounded sweep deletes expired rows. Initial handle resolution/renames can require an additional lookup before the immutable identity is known.
- Historical X data is backfilled conservatively from existing reservations/mappings. Where the old system did not retain external identity or entitlement history, the migration uses the available connection/current tier; it cannot reconstruct information that was never stored. Legacy retries retain separate estimated attempt charges.
- Provider charges are not proven by a successful HTTP response. Settled amounts are the reserved conservative estimates until actual charges are reconciled. Released rows preserve any known vendor cost.

## Validation evidence

- API: typecheck, production build/module graph, contract generation/drift, environment documentation and changed-source ESLint passed.
- Current X/outbound/media-schema regression run: 23 suites, 164 tests passed, including interrupted thread preservation, pause/lease/source-change guards, control revision checks, exact reconciliation and alert recurrence.
- Earlier focused API regression runs: 29 suites, 301 tests passed, including budgets, enrichment isolation, native Article durability, URL/metadata handling, ownership and scheduled dispatch.
- Disposable PostgreSQL: all migrations applied without schema drift; concurrent reservations respected the $8 and shared reserve caps; duplicate operations authorized one worker; uncertain holds and identity/account switching retained spend. The fixture container was removed afterward.
- Web: 40 focused tests passed, including real mounted preview interactions; isolated Chromium fixtures exercised rich/private/expired previews, six-avatar cap, explicit threads, partial-copy links, controls/reconciliation, keyboard dismissal and narrow-light/wide-dark layouts; typecheck and production build passed. All 45 configured hydration routes passed against the existing local server. Changed-file ESLint has no errors and one existing unused-handler warning in post detail.
- iOS: 32 changed Swift source/test files formatted and strictly linted; simulator build/run passed; 22 selected tests passed with no failures or skips, including shared fixture decoding and all 22 official weighted-emoji vectors. Native iPhone preview/context-menu/sheet and publication queue interaction were exercised; the iPad light-theme anchored rich preview was inspected and dismissed successfully, and the native admin pending-charge review sheet was exercised.

No production provider request, push or deployment was performed. The isolated fixture server closes after automated checks. The native fixture gallery uses only synthetic responses and blocks every unmatched API request.
