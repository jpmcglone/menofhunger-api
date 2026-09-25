# Onboarding and activation

Design: [Welcome guide](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=866-1202).
Product dashboard: [Activation](https://us.posthog.com/project/326724/dashboard/2131170).

## Member experience

Phone entry sends a code directly, with concise Terms and Privacy consent beside the action. New and returning members share the same phone/code flow; there is no signup-intro interstitial.

Required setup has two saved steps: (1) username, private birthday (18+), and explicit community confirmation; (2) at least one arena, with all seven choices visible. Partial accounts resume the first incomplete step. Returning complete accounts keep their intended destination. Captured referrals are applied without blocking setup; failures remain available for retry.

Completion opens the feed directly. Name, photo, recovery email, ZIP, referral code, and discovery source are optional profile details opened by the member. Signup does not automatically queue photo, email, or push-permission prompts.
The home feed then offers an optional guide, with one primary action:

- Before approval: request verification; discover and follow men beyond the two automatically followed starter accounts. Pending requests explain that an admin will contact the member in the app. Rejected requests return to the existing verification screen, which owns the explanation and retry flow.
- After approval: make a contribution; reply to another person; contribute on another UTC calendar day. Existing composer, discovery, check-in, verification, and notification destinations remain in use. The inline guide replaces the automatic first-post modal.

Dismissal is local, keyed by account **and approval phase**. Approval therefore resurfaces the approved guide even if the waiting guide was dismissed. Progress is shared across devices through `GET /users/me/activation`, not inferred from taps or local counters. Clients refetch on appearance, foregrounding, reconnection and relevant own follow/post/reply events. Failed refreshes retain confirmed progress and offer retry; responses from old accounts/phases are ignored.

`ActivationDto` contains phase, verificationRequested, verificationPending, followed, contributed, replied, returned. It requires authentication and reads only the current member's progress. No schema migration is required.

Progress is current state, not an immutable achievement ledger: deleting a contribution or unfollowing can change it. Contributions count published, non-deleted regular posts and check-ins with visibility other than `onlyMe`, after the latest approval timestamp. Drafts, scheduled holding rows, reposts, automatic shares and private notes do not count. A reply must target another non-bot author's non-deleted post. Return means another UTC date after the first qualifying contribution, not merely another session. Legacy approved accounts without `verifiedAt` use existing qualifying history. Discovery excludes `john`, `menofhunger`, and bots because the first two accounts are seeded at signup.

## Event ownership

All platforms use the immutable API user ID as PostHog `distinct_id`. Web and iOS identify after authentication and reset when switching accounts or signing out. Client guide events are suppressed while impersonating. Server events describe committed domain actions. Every new capture carries `platform` (`api`, `www`, `ios`) and `environment`; iOS also supplies `build_configuration`.

| Event | Owner | Meaning |
| --- | --- | --- |
| `user_signed_up` | API | New account persisted; no phone property |
| `onboarding_completed` | API | Required account setup complete; web no longer duplicates this event |
| `onboarding_step_viewed` | web/iOS | Account setup step 1 or 2 displayed (older clients emitted a third step) |
| `onboarding_gate_finished` | web | Client finished the gate; distinct from server completion |
| `verification_requested` | API | New request persisted; existing pending requests do not emit again |
| `verification_approved` | API | Approval persisted through the central verification service; source distinguishes admin and automatic approval |
| `follow_created` | API | New follow; `source=starter` distinguishes automatic seed follows from `member` |
| `member_contributed` | API | Verified human publishes a qualifying post/check-in/reply |
| `member_replied` | API | That contribution replies to another human |
| `member_received_reply` | API | Captured under the receiving person's ID; bot/self replies excluded |
| `onboarding_guide_viewed` | web/iOS | Confirmed guide displayed, once per account/phase per mounted guide |
| `onboarding_action_clicked` | web/iOS | Guide action selected; bounded action name, no draft content |
| `onboarding_guide_dismissed` | web/iOS | Member chooses to explore |
| `app_opened`, `screen_viewed` | clients | App entry / native tab navigation; web uses `$pageview` |

Contribution/reply/request events carry deterministic `$insert_id` values for ingestion deduplication. Existing `post_created` and `checkin_created` remain available; new dashboards use `member_contributed` so private notes and bots are not treated as activation.

## Measurement

The dashboard preserves previous baseline insights and adds:

- Signup → required setup → verification request, within 14 days.
- Approval → contribution → human reply received, within 7 days.
- Approval → reply to another member, within 7 days.
- First contribution → meaningful participation on subsequent strict UTC calendar days, through day 7.

The combined seven-day activation table counts members who contribute, receive a subsequent human reply, and participate on a later UTC date within seven days of approval. Its denominator includes approvals from the last 30 days with a full seven-day observation window. The maintained query is [onboarding-activation.sql](onboarding-activation.sql); synthetic fixtures validate cohort maturity and the combined conditions. Separate funnels explain each stage. Receiving a reply is a community outcome, not a member-controlled checklist task. Automatically approved members bypass the verification-request step; analyze their approval cohort separately. New charts filter production events, and recent cohorts need their full observation window. Historical traffic is not backfilled into the new definitions.

## PostHog configuration and privacy

Project: Men of Hunger, **326724**, US cloud, UTC. The iOS public project token was checked against the connected project's token. Use that same project's **public project token** for `POSTHOG_API_KEY` on the API and `NUXT_PUBLIC_POSTHOG_KEY` on web; host is `https://us.i.posthog.com`. These variables are intentionally absent locally, so local web/API SDKs remain inert until configured. Never put a personal/secure management key in a public Nuxt variable or the iOS app. The optional API feature-flags secure key remains server-only.

Web has explicit events, autocapture off, URL query/hash redaction (including initial attribution), private text/contact-field removal, and session recording explicitly disabled. iOS has replay/surveys off, local-API/test capture disabled, and explicit tab/guide events. API capture removes raw searches, phone/email, message/body content and tokens. Session replay is also disabled in the live PostHog project. Sentry has its own independent configuration.

## Release verification

Release the API before either client so `/users/me/activation` is available. Then release web and iOS. These changes and their new events have not been deployed by this task. The existing project has live event ingestion; newly configured dashboard definitions await the release.

After release, exercise a fresh member across both clients: setup, request, approval, contribution, human reply, and later-day contribution. Confirm the same person ID, `environment=production`, `platform`, no duplicate server completion, and no private payloads. Confirm account switches and logout do not attribute new events to the previous member. Compare automatic and manual approval sources. No extra MCP scope is required for the dashboards created here; `data_catalog:write` is only needed if the proposed definitions are later saved as governed metrics.

## Manual approval consistency

Admin → User verification approves every pending request in the same transaction as the badge. It preserves the request and its consent/provider history, records the reviewing admin and review time, clears rejection reasons, and refreshes every admin queue. Already-approved users have stale pending requests resolved without repeating rewards. Concurrent approvals use a conditional badge update so only one call owns rewards and notifications. Switching between manual and identity badges preserves the original approval date and onboarding progress.
