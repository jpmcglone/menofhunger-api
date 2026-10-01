# Integrations and profile previews implementation plan

Status: local implementation in progress, October 1, 2026. API, iOS and web changes are available for local review; **the full plan is not complete**. Nothing has been pushed or deployed. Credentials and production settings have not changed. See [local testing and implementation status](integrations-local-testing.md) for what works, what is implemented but disabled, and what remains unimplemented.

MOH should publish the formats each connected destination actually supports, while enforcing predictable spending. Profile links should reveal useful previews without navigating away. Reuse the existing crossposting, link metadata, profile, and location systems rather than introducing separate infrastructure for each provider.

## Design handoff

Canonical file: [Men of Hunger UI Library](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN), page **06 · Profiles**.

| Design | Figma reference |
| --- | --- |
| Profile context, website, X, Pickax, Rumble and state previews; dark and light cards | [Profile previews](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1038-1079) |
| X light/no-banner/no-message variants, loading/error/empty states and touch behavior | [Preview states](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1038-1080) |
| Allowances, publishing, partial failure, metrics, news and later integrations | [Integration flow studies](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1038-1081) |
| Light theme for the integration flow studies | [Light integration studies](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1047-1356) |
| Integration settings, composer destination and delivery panels at 390 px | [Compact panels](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1047-1477) |
| Articles, threads, video, polls, scheduling, uncertain delivery and edit/removal recovery | [Publishing formats and lifecycle](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1048-1380) |

Reusable preview masters: website `1041:898`, Pickax `1041:911`, Rumble `1041:922`, state `1041:933`, unavailable `1041:957`, loading `1041:967`, empty state `1041:973`, X dark `1025:878`, X light `1043:1131`, X without banner `1043:1155`. The existing Profile/Header masters now include the Rumble link example. The X card uses Roboto as the existing approximation of X's Chirp typography; MOH UI uses Inter.

Copy, balances, counts, headlines, profile descriptions and media in these examples are illustrative. Public-page previews must render returned metadata, not assume that any provider publishes a banner or biography. Initials demonstrate the existing missing-photo avatar fallback. These are editable design studies and reusable preview components, not a claim that provider permissions or every prototype interaction has been validated. Figma hover reactions select the matching overlay; production must implement the anchored positioning and accessibility contract below. Native panels retain the host screen's system navigation.

## Decisions and boundaries

- Figma first. After design approval, implement API/contracts, then iOS, then web, following engineering policy.
- Support destination formats based on a capability registry. A format unsupported by one destination must not prevent publishing to another.
- Expensive actions consume an explicit shared allowance; cheap/free formats do not acquire artificial paid restrictions just because X is expensive.
- A connection never automatically opts a member into publishing. Keep explicit destination selection and the public-content boundary. Never silently export private/group content.
- Profile previews attach only to metadata on the user's profile: website, X handle, Pickax handle, Rumble link, and state. This does not authorize new rich X cards on feed mentions or every link elsewhere.
- Adding a public profile link is independent of connecting publishing credentials. A typed link is not proof of account ownership.
- No in-MOH X inbox, Grok profile summary, follower graph crawling, arbitrary profile search, or full X feed in this scope.
- Rumble public profile links ship with the preview phase. Livestream data is a later, conditional enhancement; video publishing remains unverified.

## Budget and entitlement model

All amounts are monthly USD cost ceilings, not cash balances or a promise that the full amount will be spent.

| Plan | Regular integration actions | Higher-cost actions across every platform | Shared operating reserve | Maximum allocated API cost |
| --- | ---: | ---: | ---: | ---: |
| Premium | $8 | $0 | $2 | $10 |
| Premium+ | $8 | $10 | $2 | $20 |

Both paid tiers retain the same 300-X-publication ceiling per UTC calendar month. A thread consumes one slot per successfully created external post; an Article consumes one publication slot. Link publications also count toward the common ceiling. Dollar limits and count limits both apply. The $10 Premium+ pool is shared across providers, not $10 per integration. Regular and higher-cost pools do not silently borrow from one another.

The $2 reserve is internal and pooled across funded memberships for public enrichment, cache refreshes, compliance/removal work, reconciliation and operational uncertainty. Never debit a profile owner's personal allowance because someone hovered over his profile. Author-requested private analytics use the author's regular allowance; reuse already-funded public reads without billing again. Failed writes may still generate provider charges: releasing a user reservation is not evidence that the vendor refunded anything.

Use a configured company-wide ceiling alongside per-account limits. Shared spending must stay below the funded reserve, with a daily pace limit, provider sublimits and headroom for mandatory removals. Do not count unpaid, canceled or hypothetical memberships as available funding. A member's allocated maximum is a budget model, not proof of a strict vendor-side upper bound: conservative reservations, reconciliation and the reserve handle late/ambiguous charges.

Current verified nonpaid allowances exist in code. Preserve their ordinary-post behavior during this project and fund it from a separately approved, globally capped acquisition budget; do not silently charge it to paying members. The newly requested Premium+-only expensive-action rule replaces the old 3/20-link allowances when the new model launches. Document that entitlement migration and its effective date before rollout.

### Accounting requirements

1. Store money as integer microdollars or another exact decimal representation; no floating-point currency arithmetic.
2. Version the price catalog by provider, endpoint/action, account tier, effective date and billing unit. Record known cost, unknown cost, and quota-only usage separately.
3. Reserve a conservative maximum before any paid request, including media processing, metadata, expansions, pagination and bounded retries. Unknown-price capabilities stay disabled until validated.
4. Use transactions and stable operation IDs so concurrent workers cannot overspend or publish twice. Lock MOH account and external identity consistently; pages spend their own entitlement, not an operator's.
5. Track reserved, settled, released and uncertain amounts. Keep an uncertain create reserved until reconciled. Never automatically resend an ambiguous create without a provider idempotency guarantee or a conclusive lookup.
6. Settle actual charges where available. Avoid counting a shared cache refresh once for every reader. Provider deduplication is an optimization, not the correctness mechanism.
7. Reset at midnight UTC on the first, without rollover. Charge scheduled sends to the send month. Upgrade increases limits without clearing usage; downgrade preserves usage and blocks new ineligible actions. Disconnect/reconnect and account switching cannot reset spend.
8. Successful remote deletion does not refund prior publishing spend. Reserve operational capacity for required removals even when a user's allowance is exhausted.
9. Show member-facing remaining allowance, reset date, pending reservations and estimated cost for expensive actions. Do not expose the $2 operating reserve as spendable credit.
10. Alert on price drift, excess retry costs, unusually high cache misses and reconciliation differences. Provide per-provider and global kill switches that leave MOH publishing usable.

Current X reference rates include $0.015 for a regular create, $0.20 for a URL create, $0.01 per user read and $0.005 per post read. Thus 300 plain creates cost $4.50 before other work; $10 buys at most 50 URL creates before other high-cost use. Rates and billing units must be checked against our actual developer console before enabling a capability. X's daily deduplication is explicitly a soft guarantee. [X pricing](https://docs.x.com/x-api/getting-started/pricing).

## Phase 1 Budget and capability foundation

Extend the existing X usage reservations into a provider-independent ledger. Preserve historical reservations and linked external identities; do not restart usage during migration. Introduce an adapter contract that reports account-specific capabilities, supported content combinations, length/media limits, required scopes, known prices and estimated requests.

Capability state must distinguish supported, unsupported, awaiting permission, temporarily unavailable, and unknown. MOH Premium+ and X Premium/Premium+ are separate entitlements: one never proves the other. Unknown provider functionality is not a license to scrape or use undocumented publishing routes.

Deliver settings allowance rows, expensive-action estimates, reconnect/scope recovery, limit reached states and administrator spend diagnostics. Keep existing connection and delivery ownership rules.

Acceptance: concurrent reservations cannot exceed a bucket; identity switching does not reset usage; account/page/operator permissions hold; scheduled sends revalidate their entitlement; price increases block a now-unaffordable send instead of silently charging more; shared public reads cannot drain an individual account.

## Phase 2 Complete X and Pickax publishing

Inventory the current vendor contract and test-account access before claiming support. Implement every confirmed, relevant publishing format, not only the format the original MOH crosspost rules allowed.

| Capability | X plan | Pickax plan |
| --- | --- | --- |
| Text, URLs, mentions and hashtags | Native create; correct weighted character counting; URL creates use Premium+ high-cost pool | Preserve native text and link payloads; use validated length limits |
| Photos and accessibility metadata | Supported photo combinations, per-image alt text, processing status and costs | Attachments supported by the actual API; attachment names are not automatically equivalent to alt text |
| GIF and video | Add supported upload/processing flows, durations, sizes and combinations | Enable only media types Pickax confirms; a generic attachment field alone is insufficient evidence |
| Polls | Enable when current account/API supports the chosen combination | Confirm API support before showing an option |
| Long text and threads | Account-aware long-text capability; explicit editable thread adaptation if needed | Native limits; explicit adaptation if the source exceeds them |
| Native Articles | Draft creation and publish workflow, rich-text conversion, cover media, external IDs and source attribution | Existing create/update Article adapter; preserve supported formatting and images |
| Replies and quoted content | Enable only when current provider policy/account permits the action; resolve the external target | Confirm external reply/quote contract and target IDs first |
| Scheduling | MOH queue dispatches at send time; recheck scopes, identity, prices and budget | Same model |
| Edits | Native edit only when supported for this account/post/time window; never replace with a new post silently | Use confirmed update routes and stable external IDs |
| Delete, unpublish or source becomes private | Cancel pending work; request supported remote removal, surface pending/manual action honestly | Same; existing delete adapter still requires partner validation |

X documents native Article draft and publish endpoints. Build a durable two-step operation: retain the draft ID after stage one and never restart it blindly after a publish timeout. The prior $0.02 estimate is not a production promise: verify both endpoint rates, media costs and any link-related treatment in the developer console. Do not force the high-cost pool solely because something is an Article if its validated total cost is ordinary. [X Articles](https://docs.x.com/x-api/articles/introduction).

Composer design: shared source content plus destination selection; expand a destination only to review its rendering, cost or an incompatibility. No silent truncation, omitted attachment, removed URL or substituted excerpt. Offer explicit supported choices. High-cost access restrictions should explain the destination and pool involved, while leaving other destinations and MOH publishing usable.

Track per-destination queued, uploading, publishing, published, failed, uncertain and canceled states. A local publication succeeds independently of external delivery. Retry only failed destinations. Maintain edit/delete linkage and never recreate a remotely deleted copy automatically. Credential failures offer reconnect; provider rate limits respect Retry-After. Include media review ownership for uploads, drafts, scheduled assets and generated derivatives.

Acceptance: format/account matrix tests; correct cost and publication count for threads; no double creates on timeout; no silent content loss; accurate partial success; unsupported edits/removals clearly explained; source visibility changes cancel or remove copies as supported.

## Phase 3 Profile hover previews and shared caching

### Interaction contract

Open after a proposed 300 ms deliberate hover or keyboard focus. Prefetch only after this intent threshold, not on profile render or mouse movement. Use a 150 ms close grace period to cross from trigger to card. Keep open while pointer or focus is within either. One card at a time; cancel stale requests when switching identities. Position against the trigger, flip when necessary, and remain within the viewport. Short viewports allow internal scrolling without trapping the page.

Keep real anchors: a click opens the existing destination; no first-click hijack. Escape closes, keyboard focus can reach card actions, and focus returns to the trigger. Do not use a tooltip role for interactive content. For touch, retain tap-to-open and offer Preview through the link context menu/accessibility action; use a native compact sheet or a regular-width popover. Respect 44 pt targets, reduced motion, Dynamic Type and screen-reader labels. No autoplay or nested avatar hover popovers.

### Preview content

| Trigger on profile | Preview | Destination |
| --- | --- | --- |
| Website | Domain, returned page title, concise description and optional OG image | Original website |
| X username | Banner, avatar, name, handle, bio, verification when returned, following/follower totals, website; contextual relationship labels only if available | View on X; conditional Message on X |
| Pickax username | Existing public-page link metadata only; no invented profile fields or follower count | Public Pickax profile |
| Rumble link | Existing public-page metadata for a user/channel; video pages remain separate | Saved Rumble profile/channel URL |
| State name | State outline, state/country, visible MOH member count, at most six member avatars plus +N | Existing state directory |

X: preserve the screenshot's information hierarchy, add the banner, and omit unavailable functionality. No Grok summary or fake Following control. Display follows-you/following status only from a valid viewer-specific response. Do not enumerate mutual followers to mimic X. The regular card omits that row when no cheap, authorized source exists. Verification is provider verification, not MOH verification. Counts are snapshots, not real-time.

Message on X appears only when the API supplies a currently valid positive DM-availability result for the connected viewer. False, absent, stale or unavailable means hide it. Use the numeric target ID in the X compose link and test the actual handoff before launch; the browser's signed-in X account may differ. Do not request an inbox permission or read messages merely to decide whether to show a button.

Website/Pickax/Rumble: the shared metadata renderer supports missing image, missing description, loading, failed lookup and stale data. Show a domain/title fallback and working external action when a site blocks metadata retrieval. Never treat a login page as a person's profile. Do not spend paid X API credit merely to provide a generic website preview.

Rumble profile editing stores a validated canonical public URL, not a guessed @handle URL: channels and users can have different paths. Add the field through profile writes, canonical DTOs, client decoding, edit forms and social-link descriptors. Reject API-key/livestream-secret URLs in public profile fields. No creator API connection is required for this phase. Existing Rumble video oEmbed support is not a general profile or upload API.

State: reuse the existing location endpoint and shared state vector. Six real, permitted member avatars maximum; missing photos use initials. The remainder is max(visible count minus displayed avatars, 0). Use the same eligibility rules for the count and sample, including blocking/privacy as appropriate. Current state queries already return a count and sample but need a visibility-policy audit before reuse: they must not accidentally expose hidden members. Do not infer a total from six rows. No ZIP, street, city inference or external geolocation call. Show a truthful empty state; omit or safely label counts when unavailable. Non-US location text keeps its existing behavior until an equivalent directory exists.

### Cache and spend policy

| Data | Proposed refresh policy | Scope and funding |
| --- | --- | --- |
| X public user fields | At most once per 24 hours per immutable X user ID, and only when requested | Shared across the app; reserve budget |
| X public post data | At most once per 24 hours per post ID unless removal/edit evidence requires invalidation | Shared; reuse across preview and metrics |
| X relationship/DM availability | Short validity, proposed 15 minutes; fetch only if needed and affordable | Private per viewer and target; never public CDN/cache |
| Website/Pickax/Rumble public metadata | Start with existing metadata cache; refresh on demand, normally 24 hours for profile pages | Shared normalized URL; mostly hosting/fetch cost |
| State counts/member sample | Proposed five-minute TTL; invalidate on known membership/location/visibility changes | Permission-safe scope; database cost only |
| Author analytics | On opening the author's metrics, at most daily per post; bounded recent set | Author regular allowance unless reusing a public snapshot |
| News | One shared scheduled digest, at most two refreshes per day | Dedicated small sub-budget within shared reserve |

These are application freshness targets, not permission to retain vendor data indefinitely. Set separate provider-compliant retention/deletion limits and a hard display expiry; honor deletion, suspension, protection changes and revocation immediately when known. Do not serve expired X data solely because the budget is empty. Once the allowed stale window ends, show a link fallback.

Use Redis hot cache plus persisted normalized snapshots where permitted, stale-while-revalidate within policy, distributed single-flight locks and jitter. A thousand simultaneous hovers for one expired identity cause one upstream request. Negative-cache 404/metadata failures briefly with bounded backoff; revoked/protected responses invalidate visible data. Store fetchedAt, expiresAt, hardExpiresAt, source and response version. Never cache bearer tokens or viewer-specific fields in the public snapshot.

Batching reduces request overhead, not necessarily provider resource charges. Restrict expansions to necessary fields. Bound distinct cold IDs per visitor/account/IP and globally. Allow basic/cached previews for all eligible viewers; anonymous traffic cannot trigger unlimited paid misses. Hide paid enrichment or fall back when the shared budget cannot reserve the request.

A profile read once daily for a 30-day month is roughly $0.30 at the reference rate, regardless of how many viewers reuse it. Fetching 1,000 distinct profiles daily is roughly $300/month, so shared caching still needs a global ceiling. Avoid refreshing users nobody visits. Public post snapshots and author analytics must reuse one cache entry where their authorization permits.

Acceptance: no fetch on render; one upstream request under concurrent hover; no paid miss when budget fails; correct expiry/deletion; no viewer-data leakage; working keyboard/touch path; six-avatar limit; state count/sample visibility matches; blocked metadata never breaks navigation; Rumble profile URLs are not treated as video embeds.

## Phase 4 Author metrics

Attach an author-only detail panel to existing crosspost status. Show platform name, external post link, updated time and only returned metrics: likes, replies, reposts, quotes and views/impressions where entitled. Unavailable is not zero. Do not mix different definitions into a misleading cross-platform total.

Start with a proposed maximum of 20 recent external posts per opened metrics view, daily cached refresh, and a configurable $1 monthly analytics sublimit within the $8 regular bucket. This protects publishing capacity while allowing useful feedback. No refresh-all-history button and no background polling for inactive authors. Keep public and private analytics responses separate; never assume X's developer-app-owner discount applies to every connected MOH user.

Acceptance: viewers cannot read another author's private metrics; cached public data reused; no unbounded history traversal; unavailable fields omitted; stale timestamps visible; analytics limit does not prevent viewing already-cached results.

## Phase 5 Bounded news experiment

Use documented X news search/lookup if enabled for our app, after validating actual endpoint pricing. Fetch selected topics from the preceding 24 hours, deduplicate stories, show three to five source-linked items and a last-updated time. Call it Today on X or selected stories, not X's official top-story ranking. The API provides news search; an identical consumer Top Stories ranking has not been established. [X news search](https://docs.x.com/x-api/news/search-news).

Proposed pilot: one shared digest, two refreshes/day maximum, seven days, with spend capped at the smaller of $10 or 10% of available monthly shared reserve. No per-reader fetch, no open-ended search and no continuous paid news webhook. Feature remains off when endpoint cost is unknown. Do not quietly substitute paid post search as a fallback. Monitor useful outbound opens, repeated readership, cost per digest and cost per engaged reader; continue only if it earns its budget.

## Phase 6 LinkedIn

Begin with member-authorized publishing and a public profile link. Enable text, link shares and approved image/video/document/poll formats supported by our approved app and the source composer. Test organization publishing separately with the required role and permission. LinkedIn's Article content type in a post must not be presented as proof of native newsletter/long-form article publishing.

Use versioned API requests and permission-aware capabilities. Public links receive generic metadata fallback when LinkedIn blocks access. Do not promise follower lists, connection graphs or unrestricted profile scraping. Official API access and post format docs establish capabilities; they do not establish our app's approval or unlimited free usage. No per-post charge was established for this plan; track quotas independently and confirm terms before launch. [LinkedIn access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) and [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).

Acceptance: member and organization identities cannot be confused; expired/missing scopes have recovery; account-approved formats render correctly; unsupported content remains editable; successful sends have stable IDs and status; no unapproved profile enrichment.

## Phase 7 YouTube previews

Add a channel URL to profile metadata and reuse public video previews for links. Prefer known video/channel IDs, public metadata or documented embeds to broad search. Show thumbnail, title, channel attribution and any approved statistics, with click-to-watch. No autoplay on hover. Avoid duplicating existing YouTube metadata enrichment.

Google quota units are not dollar charges. Keep a provider quota ledger and verify the project's current limits instead of hardcoding historic search/upload costs. Video lookup is documented at one quota unit per request. Plan periodic data refresh/removal according to YouTube's rules. Uploading and channel management remain a separate later project, including project verification and media review. [Video lookup](https://developers.google.com/youtube/v3/docs/videos/list), [quota overview](https://developers.google.com/youtube/v3/getting-started), [2026 quota revisions](https://developers.google.com/youtube/v3/revision_history).

## Rumble follow-up after profile links

Optional creator-authorized live integration: live status, stream title, viewer count and follower count, with Watch on Rumble. Keep the secret API URL encrypted server-side and out of logs, client DTOs, URLs, analytics and caches served to visitors. Expose only allowlisted public fields; the API response includes data the public card does not need.

Use conservative polling only for opted-in creators and active viewers, with a live/offline backoff. Hide an expired live badge rather than implying the stream is still running. Rumble's documentation does not publish a per-request price or rate limit, so confirm both and intended use before enabling. Chat, Rants, subscriber identities and gifted subscriptions are available to the creator API but are not needed for this profile card. No automatic video crossposting until a supported publishing API and commercial terms are established. [Rumble livestream API](https://rumble.support/help/how-to-use-rumble-s-live-stream-api).

## Implementation ownership

| Existing area | Planned change |
| --- | --- |
| API `src/modules/x/x-usage.service.ts` | Migrate provider-specific counts to shared exact-cost reservations while preserving current history |
| API X/Pickax clients, connection and crosspost services | Capability adapters, formats, account validation, lifecycle and delivery recovery |
| API `src/modules/link-metadata` | Reuse normalized public metadata, cache locks and Rumble/YouTube enrichment; distinguish profile pages from videos |
| API users/profile DTOs and write service | Rumble canonical URL, later LinkedIn/YouTube URLs, permission-safe state summary and preview contracts |
| API existing queues/config/admin diagnostics | Bounded enrichment, cost catalog, switches, reconciliation and spend visibility |
| Web profile `Header.vue`, `utils/social-links.ts`, link-preview composables | Exact profile triggers, Rumble display, accessible popover placement and reusable cards |
| Web profile editor, integrations settings and composer | Public URL fields, allowances, cost estimates, destination preview and delivery states |
| iOS `User+SocialLinks.swift`, Profile services/screens and location screen | Shared DTO decoding, canonical URLs, link preview action/sheet, state card and regular-width popovers |
| iOS/web author post detail and experiment host | Metrics and bounded news card without new primary navigation |

Revalidate file locations against the working tree at implementation time. Do not duplicate mutable state between stores and screens. Use canonical API DTOs and typed realtime patches; update both client decoders for every shared contract. Public metadata cache headers must never be reused for viewer-specific X data or visibility-filtered state responses.

## Rollout and validation

Deliver in the requested sequence: foundation → X/Pickax publishing → profile previews/cache including Rumble links → author metrics → bounded news → LinkedIn → YouTube previews. Rumble live data is optional after the links are established. Ship each vertical slice behind its own switch; provider denial must not block the rest.

Before enabling paid actions, audit the actual app's scopes, account entitlements, current prices and provider limits with test accounts. Before broad preview rollout, audit SSRF protection across URL normalization, redirects, DNS/private-address checks, timeouts and response-size limits; sanitize returned text and validate image URLs. User URLs and retrieved metadata are untrusted content.

During implementation, run the engineering-policy gates appropriate to touched areas: relevant budget/concurrency and adapter tests; API types/build/contracts; iOS format/strict lint/build and decoding/UI tests; web lint/types/build and focused keyboard/pointer/touch tests. Verify both themes, compact iPhone and regular iPad/web widths, long bios/titles/handles, absent banner/photo, six versus zero members, permission changes, multiple tabs, offline mode, expired tokens, provider 429/5xx and unknown delivery outcomes. Cover ownership of every stored preview image or generated media derivative in the media-review resolver and stale-orphan deletion regression tests.

Roll out to test accounts, then a small enabled cohort. Compare reserved versus actual cost, cache hit rate, duplicate writes, preview latency and provider failures. Rollback disables new paid operations while preserving MOH publishing, cached results permitted by policy, external links, pending reconciliation and required remote removals. Do not monitor production deployments without a separate user request.

## Launch gates still requiring evidence

- Actual app/account permissions and final prices for X Articles, long text, edits, polls, reply/quote combinations, user-context DM availability, metrics and news.
- Pickax media types, current limits, remote removal and reciprocal OAuth contracts; fixture endpoints are not deployed API evidence.
- A safe, working X compose-message handoff and conditional permission semantics.
- Rumble user/channel URL validation and metadata behavior; pricing/rate limits before any creator API polling.
- LinkedIn app approval/scopes and YouTube project quota/terms.
- Funding for existing nonpaid X publishing before migrating the old link entitlements.

These are implementation acceptance gates, not reasons to postpone the shared designs or build unrelated functionality now.

## October 1 X implementation update

X advanced publishing, database budget aggregation, admin spending controls/reconciliation on iOS and web, deduplicated operational alerts, durable public preview/metrics snapshots, and isolated native/browser provider fixtures are implemented locally. See [local testing and precise remaining limits](integrations-local-testing.md). Advanced formats use the explicit post-detail review editor; account-specific live access and price ceilings remain activation gates. No push or deployment has been performed.
