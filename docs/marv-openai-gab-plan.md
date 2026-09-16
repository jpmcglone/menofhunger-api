# Marv with OpenAI and Gab: implementation plan

Date: September 16, 2026  
Status: Proposed; implementation deferred at the owner's request.  
Preferred outcome: Gab becomes the default for member-facing Marv after a successful admin pilot; OpenAI remains a supported alternative.

Quick navigation: [Product direction](#1-product-direction) · [Current implementation](#2-current-implementation-and-constraints) · [Provider evidence](#3-what-documentation-establishesand-what-still-needs-proof) · [Architecture](#5-proposed-architecture) · [Persona](#6-portable-persona-and-instructions) · [Admin settings](#7-configuration-and-admin-experience) · [Migration](#8-data-model-and-migration) · [Conversation privacy](#9-conversation-continuity-and-permissions) · [Reliability](#10-tools-search-images-and-reliability) · [Diagnostics](#11-credits-cost-and-diagnostics) · [Tests](#12-evaluation-and-acceptance-criteria) · [Rollout](#13-delivery-milestones-and-rollback) · [Reference library](#15-reference-library-and-code-map).

## 1. Product direction

Marv should sound like he belongs on Men of Hunger: direct, concise, confident in the community's convictions, comfortable discussing religion and contentious cultural questions, and free of unnecessary corporate language or moralizing preambles. The owner wants to evaluate Gab because the current experience feels too filtered.

Treat that as a measurable product requirement. A provider name is not a personality, and moving the same underlying model behind another endpoint may not change its behavior. Compare actual responses before deciding that the migration succeeds.

Separate three decisions:

| Decision | What it controls |
| --- | --- |
| Marv's persona | His voice, stated convictions, brevity, and how he addresses members. Owned and versioned by Men of Hunger. |
| Provider | The company receiving API requests: OpenAI or Gab. |
| Model | The particular engine selected within that provider. |

“More based” should mean less evasive on legitimate questions, clearer commitments, stronger practical answers, and a better fit for this community. It should not mean inventing evidence, agreeing with every premise, attacking a member instead of answering him, or leaking information. A direct disagreement can be an excellent Marv response.

Preserve the existing theological stance unless the owner separately changes it. The current code explicitly specifies a Reformed Calvinist Baptist (1689), postmillennial, partial-preterist perspective for relevant questions. Do not replace that with a generic vendor persona or inject theology into unrelated requests.

## 2. Current implementation and constraints

The code currently defaults to these OpenAI models; environment overrides can change them:

| Workload | Default |
| --- | --- |
| Fast | `gpt-5.6-luna` |
| Regular | `gpt-5.6-terra` |
| Smart | `gpt-5.6-sol` |
| Separate admin intro-brief jobs | `gpt-6-astra` |

See [model definitions](../src/modules/marvin/marvin-models.ts) and [application configuration](../src/modules/app/app-config.service.ts). Live usage inspected on September 16 confirmed Luna serving successful public mentions, private messages, and catch-up requests. That observation does not establish every deployed environment override.

The current [AI service](../src/modules/marvin/services/marvin-ai.service.ts) owns OpenAI Responses requests, tool rounds, image inputs, hosted search, reasoning options, response continuation, retries, and estimated cost. A shared 210-second generation deadline already limits retries and tool rounds. Keep this bounded behavior.

The full persona still lives in an OpenAI stored prompt. [Local instructions](../src/modules/marvin/marvin-prompt-instructions.ts) and the [prompt builder](../src/modules/marvin/services/marvin-prompt-builder.service.ts) add per-request behavior and context. Both pieces must be inventoried before making a portable prompt; copying only the local constants would omit part of Marv's identity.

[Private conversation state in the Prisma schema](../prisma/schema.prisma) stores `lastResponseId` without a provider namespace. Usage records store a model and estimated dollars, but no explicit provider. Both need changes before switching providers safely.

An existing configuration gap should be addressed in this work: the [admin service](../src/modules/marvin/services/marvin-admin.service.ts) persists `fastModel`, `regularModel`, and `smartModel`, while the inspected generation path resolves models from application environment configuration. Do not build another selector that merely saves a value. Add one effective-configuration resolver and prove the selected model reaches the outgoing request.

Keep recent delivery fixes intact: consent belongs to the human requester, internal bot posting remains constrained, delivery failures refund member credits, and private continuation advances only after the reply is saved. See [the debugging guide](marv-reply-debugging.md).

## 3. What documentation establishes—and what still needs proof

Gab documents an OpenAI-compatible base URL at `https://gab.ai/v1`, Responses and Chat Completions endpoints, function calls, continuation IDs, and model-dependent image support. Its [public model catalog](https://gab.ai/v1/models) is available at `/v1/models`. API access requires Plus and consumes credits. Gab also offers `auto` routing, whose selected model can vary. These are documented capabilities, not a successful compatibility test against Marv. [Gab API documentation](https://gab.ai/docs/api)

Start the pilot with a pinned Gab model, with Arya as one candidate to evaluate. Do not assume every model receives the same persona, search behavior, or filtering. Record the actual returned model. Confirm account availability and current capability metadata during implementation rather than freezing today's catalog into this plan.

OpenAI's current text-generation guidance recommends keeping prompts in code and passing built instructions directly. It also documents a scheduled November 30, 2026 shutdown of reusable prompt objects. Exporting Marv's stored prompt is therefore useful even if the Gab work remains deferred; recheck the deadline before scheduling that dependency migration. [OpenAI text-generation guidance](https://developers.openai.com/api/docs/guides/text)

OpenAI supports response continuation, but provider-managed history is not an application-level portable transcript. Use the app's authorized conversation records as the recovery source. [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

Unverified items to resolve with bounded synthetic tests: Gab's exact handling of our function schemas and developer instructions; hosted search with custom tools; response storage and expiry; supported request fields; refusal/incomplete-response shapes; upstream model identity; credit accounting; and retention/deletion behavior. The documented OpenAPI URL returned 404 during this review. Fetch a working schema or establish captured response fixtures during the spike rather than treating SDK types as proof of compatibility.

## 4. Scope and sequence

The first implementation should support public mentions, Marv DMs, and catch-up through a shared provider layer. Keep member verification, Premium eligibility, audience checks, and credit policy unchanged. Only verified users can purchase Premium; a provider change must not create a second entitlement system.

Initially leave admin assistants, intro briefs, analytics briefs, scheduled summaries, and context-card generation on their existing routes. Inventory every caller of the AI service and every direct SDK call, then explicitly assign each workload. A shared service refactor must not move unrelated workloads by accident. Background summaries and context cards must have provenance and compatible disclosure even if their generator remains OpenAI.

No public model picker, arbitrary endpoint field, model marketplace, fine-tuning project, or automatic paid-credit change is needed. Keep existing GitHub Actions limited to linting/formatting; verification runs locally. Do not introduce Playwright or visual-regression infrastructure for this migration.

## 5. Proposed architecture

Implementation starting points: [Marv module wiring](../src/modules/marvin/marvin.module.ts), [mode routing](../src/modules/marvin/services/marvin-routing.service.ts), [public reply worker](../src/modules/marvin/jobs/marvin-public-reply.processor.ts), [DM reply worker](../src/modules/marvin/jobs/marvin-private-reply.processor.ts), and [catch-up service](../src/modules/marvin/services/marvin-catch-up.service.ts).

Keep business rules and delivery in Men of Hunger. Extract provider-specific request construction and response parsing behind a small interface. Prefer adapting the existing service over building a generic AI framework.

```text
Triggering post / DM / catch-up
  -> requester, consent, entitlement, and audience checks
  -> mode routing + effective provider configuration
  -> versioned persona + authorized context
  -> provider adapter <-> existing permission-checked tool dispatcher
  -> normalized reply + usage + diagnostics
  -> delivery with current permissions rechecked
  -> usage/refund settlement + continuation checkpoint + realtime events
```

Suggested responsibilities, with names provisional:

| Component | Responsibility |
| --- | --- |
| `MarvinProviderConfigService` | Resolve effective provider/model, rollout eligibility, capabilities, and configuration version. |
| Existing `MarvinAIService` | Coordinate the turn, deadline, tool limits, and normalized result. |
| `OpenAIResponsesAdapter` | Preserve current OpenAI behavior and translate normalized inputs/results. |
| `GabResponsesAdapter` | Handle Gab-specific fields, capabilities, errors, usage, and response parsing. |
| Existing prompt builder | Build the same product instructions and authorized context for both. |
| Existing processors/writers | Own idempotency, charging, persistence, realtime delivery, and refunds. |

The provider result should include text, requested and actual model, provider response/request IDs, tool requests, normalized token usage, native billing units, completion status, and a safe failure classification. Distinguish empty output, refusal, token exhaustion, and transport failure. A refusal is not a network retry condition.

Use separate SDK clients and keys per provider. Restrict endpoints in server configuration; do not accept arbitrary URLs from a browser. Keep credentials in the deployment secret store. Return only configured/available status to admin UI. Preserve the installed SDK unless the compatibility spike proves a specific upgrade necessary.

## 6. Portable persona and instructions

Prompt references: [current behavioral instructions](../src/modules/marvin/marvin-prompt-instructions.ts), [builder regression tests](../src/modules/marvin/services/marvin-prompt-builder.service.spec.ts), [OpenAI guidance on code-managed prompts](https://developers.openai.com/api/docs/guides/text#version-prompts-in-code), and [deprecation notices](https://developers.openai.com/api/docs/deprecations).

Export the actual deployed stored prompt and its version through the owner's authorized OpenAI account. Review its variables, tool definitions, and instructions alongside local constants. Remove contradictions and duplicated rules deliberately; do not silently rewrite product decisions during the export.

Build one versioned prompt artifact with four sections:

1. Identity and voice: Marv speaks in the first person, belongs to Men of Hunger, answers directly, and avoids filler.
2. Community convictions: preserve the existing explicit perspective where relevant, while distinguishing factual evidence from interpretation.
3. Source behavior: brief public replies, useful DM answers, faithful catch-up summaries, correct handles and citations, and existing output bounds.
4. Context and tools: what each source may access, when to fetch information, and how to handle missing evidence.

Send the applicable instructions on every turn and tool continuation. Include a prompt version or hash in diagnostics. Treat posts, bios, group descriptions, retrieved pages, and tool output as data, not instructions that can change permissions or select providers.

First compare the portable OpenAI prompt against the current OpenAI baseline. Then use that same portable prompt for Gab comparisons. This separates prompt regressions from provider differences. Prompt changes can improve tone, but they cannot guarantee any underlying model will answer every request.

Do not mirror independently editable prompts in two vendor dashboards. Once the portable prompt passes parity tests, code becomes the source of truth; remove the stored-prompt requirement from readiness checks only when the replacement is actually wired.

## 7. Configuration and admin experience

Use the existing [Marv admin area](https://menofhunger.com/admin/marv) and its [web implementation](../../menofhunger-www/pages/admin/marv.vue). Design the added states in the [canonical Figma library](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN) before implementing the UI. No Figma changes are part of this documentation task.

Proposed fields:

| Setting | Initial behavior |
| --- | --- |
| Member default provider | OpenAI during the pilot; Gab after promotion. |
| Gab availability | Disabled until credentials and compatibility checks pass. |
| My test provider | Inherit, OpenAI, or Gab; site-admin-only. |
| Provider model mappings | Explicit Fast, Regular, and Smart model choices for each provider. |
| Prompt version | Read-only deployed version. |
| Effective route preview | Shows provider, model, source of override, capabilities, and configuration version. |
| Emergency disable | Prevents new requests to a failing provider. |
| Automatic provider fallback | Off initially. |

The server checks admin status on reads and mutations. A demoted admin's override stops taking effect. Clients cannot obtain experimental routing by supplying a provider field in ordinary message requests.

Resolve in this order: source eligibility and emergency controls; valid admin override; member default; model for the selected mode. Environment values supply secrets and initial defaults; persisted configuration supplies deliberate runtime choices. Invalid saved configuration fails visibly instead of silently choosing another provider.

Persist a monotonically increasing configuration version. Save changes atomically with an audit record, invalidate worker caches, and notify connected admin clients through the existing realtime mechanism. Use version checks to prevent one admin tab overwriting a newer change.

Freeze the route when a job is accepted so retries remain reproducible. Recheck emergency disable, access, and consent before execution; if invalidated, stop and settle rather than silently rerouting. UI copy should say changes affect new requests.

An admin override affects requests initiated by that admin, not everyone viewing the same thread. A test reply posted publicly is still a real public reply. Prefer an isolated preview using synthetic examples first; do not automatically mirror member traffic to both companies for comparison.

The web admin setting should apply to that account's requests from iOS as well. An iOS admin picker can be deferred; the server owns routing. Member-facing provider/disclosure state must remain accurate on both clients, including older supported versions.

## 8. Data model and migration

Migration and contract references: [Prisma schema](../prisma/schema.prisma), [API contract guide](api-contract.md), [contract generation script](../scripts/emit-contracts.mjs), [shared fixture generation](../scripts/sync-contract-fixtures.ts), [web generated contract types](../../menofhunger-www/types/api-contracts.gen.ts), and [iOS release contract tests](../../menofhunger-ios/MenOfHungerTests/ReleaseContractTests.swift). Generated artifacts should be regenerated through the documented workflow.

Use an additive migration first; retain existing columns until the rollout and rollback window closes. Exact names should be settled against current schema conventions during implementation.

| Existing area | Proposed additions |
| --- | --- |
| `MarvinGlobalSettings` | Default provider, provider enablement, per-provider model mappings, configuration version. |
| Admin preferences | Nullable test override, actor identity, updated timestamp. |
| `MarvinPrivateSessionState` | Provider, model, prompt version, context revision, continuation boundary/version. |
| `MarvinUsageEvent` | Provider, requested/actual model, prompt/config versions, attempt correlation, native provider charge units, cost basis. |
| Provider-attempt records, if needed | One request's retries/fallbacks and their individual costs without duplicating member credit charges. |

Backfill existing conversation continuation IDs as OpenAI. Preserve historical usage amounts and identify historical provider attribution explicitly; do not recalculate old charges with today's rates. Unknown values stay unknown rather than becoming zero.

Review generated SQL and the target database before applying locally. Validate against an isolated database, regenerate Prisma and API contracts, and add affected web/iOS decoding tests. Deploy schema support before code that reads new columns—the previous missing-column failure is a regression case to prevent.

## 9. Conversation continuity and permissions

Context and permission references: [thread context builder](../src/modules/marvin/services/marvin-thread-context.service.ts), [post access checks](../src/modules/marvin/services/marvin-post-access.ts), [AI consent enforcement](../src/modules/marvin/services/ai-consent.ts), [context cards](../src/modules/marvin/services/marvin-context-card.service.ts), and [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

Never pass an OpenAI response ID to Gab or vice versa. Initially reset continuation whenever provider, model, prompt version, or relevant context revision changes. Rebuild a bounded context from authorized messages in that same conversation, with an eligible summary if available. Do not copy opaque reasoning items or vendor-specific tool IDs across providers.

Keep one active continuation checkpoint for a conversation. Switching away and back should rebuild from current app history, not resume a stale branch that missed intervening messages. Preserve message ordering with a per-conversation lock or existing queue serialization; concurrent jobs must not overwrite each other's checkpoints.

Checkpoint only after successful reply persistence. If a response was generated but saving failed, do not let later replies refer to something the member never saw. Preserve source-message idempotency across retries and provider changes. If a permission or deletion event invalidates retained context, clear the continuation and reconstruct it before another request.

Preserve the owner's content rules: public content can be used; restricted thread or group content can be used in that conversation's context when authorized. Unrelated private conversations and private Apple Health/fitness records remain excluded. Verify context-card and summary provenance too; a summary is not an exception to the source's audience restrictions.

Provider disclosure and permission must cover the actual destination. Update existing compact inline copy and Settings; do not reintroduce repeated blocking modals. An old choice specifically authorizing OpenAI should not silently become permission to send private conversation history to Gab. The admin pilot can explicitly identify its test provider; broader rollout needs the corresponding member flow. Retention and deletion promises must match verified provider behavior, including upstream processors.

## 10. Tools, search, images, and reliability

Protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [rate limits](https://developers.openai.com/api/docs/guides/rate-limits), and [error codes](https://developers.openai.com/api/docs/guides/error-codes). Check these against [Gab’s compatibility documentation](https://gab.ai/docs/api), not against SDK types alone.

Keep authorization inside existing tool handlers. Neither provider gets direct database access, credentials, or permission to expand the current user's audience. Validate function names and arguments; cap tool rounds, output size, and total time. Treat malformed or unknown calls as controlled failures.

Build a capability table for each allowed provider/model pair. The pilot must prove multi-round function calls, multiple calls in one response, tool errors, and mixed text/tool output. Parse all relevant response items rather than assuming text is first.

Search needs a specific compatibility test: explicit search requests must really invoke a working search path and preserve source URLs. If Gab cannot combine its search with Marv's functions, either implement a reviewed shared search tool or mark that mapping ineligible for search. Never silently answer a demanded live search from memory.

Likewise, image requests must route to a tested vision-capable model or return an honest unsupported-state response. Preserve existing media access checks, attachment limits, and expiring-URL behavior. Do not silently drop an image while saying Marv inspected it.

Preserve the current generation deadline and add a worker-level bound covering persistence and final cleanup. All network/tool operations must respect cancellation. Always stop typing in finalization; make late responses unable to deliver after the job is settled. Retry transient failures with bounded backoff inside the same deadline. Avoid nested SDK and service retries multiplying the attempt count.

Keep cross-provider fallback off during the pilot so failures and voice differences are visible. If enabled later, limit it to eligible transient outages, require destination permission, rebuild context, and log the change. Do not automatically route a refusal to another model. Never repeat a side-effecting tool call unless the existing application operation guarantees idempotency.

## 11. Credits, cost, and diagnostics

Accounting and operations references: [member credit service](../src/modules/marvin/services/marvin-credit.service.ts), [usage recording](../src/modules/marvin/services/marvin-usage.service.ts), [failure classification](../src/modules/marvin/services/marvin-failure.ts), [CLI/MCP guide](../tools/mcp/README.md), and [production Jobs screen](https://menofhunger.com/admin/jobs) (administrator sign-in required).

Separate member credits from provider charges. A member should not pay twice because we retried or changed an internal route. Use the existing reservation/refund semantics and prove one final settlement per source request. Delivery failure should preserve the current refund behavior.

Provider cost can still exist when the member is refunded. Track every billable attempt separately and aggregate it into the interaction; do not hide unsuccessful generation costs. Keep native provider credit units distinct from Men of Hunger credits and dollar estimates. Only show converted USD where a verified conversion and rate version exist. Do not label unknown cost “free.”

Extend the current Marv admin usage view and CLI workspace with provider/model filters and a useful request detail view. Record source ID, job/attempt IDs, provider, requested/actual model, config/prompt versions, generation time, delivery time, tool count, normalized failure reason, delivery result, and credit settlement. Include provider request IDs when available.

Keep message bodies, tool arguments/results, secrets, and unredacted exceptions out of normal diagnostics. Audit existing logging while touching the shared service; new safe logs alone do not remove older raw logs. Captured evaluation text belongs in a restricted, explicitly enabled test artifact using synthetic data.

Update [the troubleshooting guide](marv-reply-debugging.md) with provider-specific triage: unavailable key/model, exhausted balance, timeout, invalid continuation, tool incompatibility, empty response, permission change, or delivery failure. A completed queue job is still not proof of a saved reply.

## 12. Evaluation and acceptance criteria

Evaluation references: [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices), [local release checks](local-release-checks.md), [validation matrix](engineering-policy.md#validation-matrix), and the [regression test map below](#regression-tests-to-extend).

Use two independent gates: functional reliability and Marv's voice. A model must pass both. Build a small, versioned synthetic fixture set before tuning prompts.

Suggested first corpus: 60 cases, with repeated runs for unstable cases.

| Category | Cases | What to assess |
| --- | --- | --- |
| Faith and theology | 10 | Maintains the specified perspective; answers the actual question; does not invent Scripture. |
| Cultural and political discussion | 10 | Direct engagement with legitimate controversial questions; distinguishes claims from evidence. |
| Work, discipline, family, community | 10 | Practical, brief, recognizable Marv voice without constant lecturing. |
| Thread catch-up and group context | 10 | Accurate attribution, group relevance, restricted-context boundaries. |
| Member lookups and multi-turn DMs | 10 | Correct tools, handles, memory, and honest uncertainty. |
| Search, images, disagreement, and missing facts | 10 | Uses available evidence; handles limits; does not agree merely to please the requester. |

Score directness, voice fit, factual support, relevance, and tool correctness separately. Record unnecessary refusal/deflection separately from factual disagreement. Let the owner review blind side-by-side answers and label the desired voice; automated graders can assist but should not decide theological or product fit by themselves.

Proposed pilot gates, to confirm when baseline measurements exist:

- All permission, deletion, delivery-idempotency, credit-settlement, and provider-isolation regression tests pass.
- At least 95% of the controlled functional cases complete correctly, with every remaining failure understood; no critical privacy or duplicate-delivery failure is acceptable.
- The owner prefers the candidate's voice in at least 70% of relevant paired examples, without a material decline in factual/tool correctness.
- Basic-text p95 latency stays within 1.5 times the measured OpenAI baseline on the same corpus. Search and tool-heavy cases have separate budgets; none exceed the configured hard deadline.
- Actual pilot spend is measured against an explicit daily cap before member rollout. Thresholds are proposed decision rules, not current performance claims.

Deterministic tests should cover configuration precedence, non-admin override rejection, demotion, queued configuration changes, secret omission, capability rejection, prompt versions, output parsing, stale continuation, overlapping DMs, timeout cleanup, provider outages, malformed calls, duplicate jobs, credit exhaustion, save failures, revocation, and deletion. Keep recent bot-writer regressions in the suite.

Live smoke tests are opt-in, use dedicated credentials and synthetic/disposable accounts, and have request/spend limits. Never send production posts, DMs, or private transcripts as an automatic build step. Run focused API tests/types/build, affected contract checks, web tests/build, and iOS decoding/build checks according to the [validation matrix](engineering-policy.md#validation-matrix). Manually verify one mention, DM continuation, catch-up, search, image, and failure state on web and iOS.

## 13. Delivery milestones and rollback

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 0: Compatibility spike | Synthetic Gab requests and captured protocol fixtures; complete caller inventory. | Required capabilities demonstrated; unresolved gaps listed explicitly. |
| 1: Portable Marv prompt | Exported/reconciled instructions in code with versions and fixtures. | OpenAI behavior meets baseline; no stored-prompt dependency in the migrated path. |
| 2: Provider foundation | Adapters, effective config, additive schema, normalized usage and continuation. | OpenAI regressions pass; no member traffic moved. |
| 3: Admin pilot | Figma states, web admin selector, server-enforced override, diagnostics. | Owner can test from web/iOS; ordinary members still use OpenAI. |
| 4: Voice and reliability evaluation | Paired report with quality, latency, cost, and failure breakdown. | Gab model mappings chosen from measured results. |
| 5: Gab member rollout | Accurate disclosure, compatible clients, gradual eligible cohort. | Sustained delivery and quality within agreed budgets. |
| 6: Gab default | Broad member routing with OpenAI retained as an explicit alternative. | Monitoring stable; rollback demonstrated; documentation updated. |

This is several focused implementation slices, not a base-URL edit. The main uncertainty is provider compatibility, not drawing the selector. Estimate engineering time after milestone 0 rather than promising a schedule before testing tools and search.

Rollback should be a configuration operation supported by both adapters. Disable new Gab work, stop or settle affected queued jobs according to the frozen-route rule, and return eligible new requests to OpenAI. Rebuild conversation context rather than sending Gab IDs to OpenAI. If permission does not cover the alternate destination, pause that request instead of silently switching it.

Do not roll back the additive schema or delete transcripts to recover service. Preserve usage and audit history. Test rollback while requests are queued and while one is generating; verify one visible reply at most, one member charge at most, and a stopped typing indicator.

## 14. Decisions deliberately left open

Choose exact Gab Fast/Regular/Smart mappings only after the live spike and voice evaluation. Decide whether all three modes need distinct models based on measured quality and cost, while preserving their user-visible roles. Keep Gab `auto` as a later experiment rather than combining two opaque routing systems on day one.

Confirm provider retention/deletion support, actual API charges, production rate limits, and permitted upstream processing before member rollout. Decide whether an optional transient-outage fallback is worth the voice and disclosure complexity after the pilot. Treat migration of other admin/background AI workloads as separate scoped decisions.

No provider, prompt, schema, production setting, or user account was changed to create this plan. The next authorized implementation step would be milestone 0; the intended end state is Gab-first Marv with a tested OpenAI alternative.


## 15. Reference library and code map

Links reviewed September 16, 2026. Provider documentation describes advertised behavior; the compatibility spike must establish behavior for the exact account and model. Local links below refer to existing files; the proposed adapters do not exist yet. Sibling-repository links assume the API, web, and iOS checkouts remain beside one another.

### Gab documentation and model selection

| Link | Use during implementation |
| --- | --- |
| [Gab documentation home](https://gab.ai/docs) | Entry point if vendor documentation moves. |
| [API integration guide](https://gab.ai/docs/api) | Authentication, endpoints, request examples, routing, usage, and timeout guidance. |
| [Live API model catalog](https://gab.ai/v1/models) | Fetch current model identifiers and advertised capabilities; JSON endpoint, not a settings page. |
| [Model overview](https://gab.ai/docs/models) | Candidate discovery; confirm API availability with the live catalog. |
| [Credits and billing](https://gab.ai/docs/credits) | Understand vendor credit terminology before building cost reporting; distinguish app benefits from API billing. |
| [Gab quickstart](https://gab.ai/docs/quickstart) | Account/product orientation before API setup. |
| [Arya positioning](https://gab.ai/right-wing-ai) | Understand the advertised voice to compare against Men of Hunger's actual evaluation corpus. Marketing is not an acceptance test. |

For missing protocol or retention details, [Gab’s documentation lists its support contact](https://gab.ai/docs). The [advertised OpenAPI schema location](https://gab.ai/openapi.json) returned 404 during this review: it is a follow-up lead, not a verified working specification.

### OpenAI integration references

| Link | Use during implementation |
| --- | --- |
| [Text generation and prompt versioning](https://developers.openai.com/api/docs/guides/text) | Move the hosted persona into the application and construct portable instructions. |
| [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) | Review continuation behavior and context reconstruction. |
| [Function calling](https://developers.openai.com/api/docs/guides/function-calling) | Check function schemas, call IDs, tool outputs, and multiple rounds. |
| [Web search](https://developers.openai.com/api/docs/guides/tools-web-search) | Establish the existing search behavior and citation contract. |
| [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) | Compare image input formats and limits. |
| [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) | Check caching behavior and usage accounting after moving instructions. |
| [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits) | Design bounded retry and backoff behavior. |
| [Error codes](https://developers.openai.com/api/docs/guides/error-codes) | Map provider failures into safe application diagnostics. |
| [Data controls](https://developers.openai.com/api/docs/guides/your-data) | Verify storage, retention, and deletion assumptions before writing disclosure copy. |
| [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | Build repeatable comparisons and maintain regression fixtures. |
| [Deprecations](https://developers.openai.com/api/docs/deprecations) | Recheck scheduled removals before implementation and deployment. |

### API implementation map

| Existing file | Why it matters |
| --- | --- |
| [Application configuration](../src/modules/app/app-config.service.ts) | Existing keys, model defaults, vision/search flags, and limits. |
| [Model identifiers and rates](../src/modules/marvin/marvin-models.ts) | Current OpenAI mappings and estimated cost assumptions. |
| [AI orchestration](../src/modules/marvin/services/marvin-ai.service.ts) | Main extraction point for adapters and normalized responses. |
| [Mode router](../src/modules/marvin/services/marvin-routing.service.ts) | Preserve Fast/Regular/Smart selection independently of provider. |
| [Marv controller](../src/modules/marvin/marvin.controller.ts) | Existing route schemas and admin configuration surface. |
| [Admin service](../src/modules/marvin/services/marvin-admin.service.ts) | Persisted settings and admin usage queries. |
| [Function tool definitions](../src/modules/marvin/marvin-ai-tools.ts) | Public/context tool schema compatibility. |
| [Personal tool definitions](../src/modules/marvin/services/marvin-personal-tools.ts) | DM/personal tool schema compatibility. |
| [Tool handlers](../src/modules/marvin/services/marvin-tool-handlers.service.ts) | Keep permission enforcement on the server. |
| [Vision media helpers](../src/modules/marvin/services/marvin-vision-media.ts) | Preserve media filtering and attachment handling. |
| [Public reply worker](../src/modules/marvin/jobs/marvin-public-reply.processor.ts) | Generation, post delivery, charging, and error settlement. |
| [Private reply worker](../src/modules/marvin/jobs/marvin-private-reply.processor.ts) | DM delivery and continuation checkpoint ownership. |
| [Catch-up service](../src/modules/marvin/services/marvin-catch-up.service.ts) | Separate catch-up response lifecycle. |
| [Thread summaries](../src/modules/marvin/services/marvin-thread-summary.service.ts) | Background generation and summary provenance. |
| [Context cards](../src/modules/marvin/services/marvin-context-card.service.ts) | Member context and background workload inventory. |
| [Schema](../prisma/schema.prisma) | Additive provider, conversation, usage, and configuration metadata. |

### Web, iOS, and design touchpoints

| Existing surface | Why it matters |
| --- | --- |
| [Web Marv admin page](../../menofhunger-www/pages/admin/marv.vue) | Provider selector, effective configuration, and usage diagnostics. |
| [Web consent state](../../menofhunger-www/composables/useAiConsent.ts) | Provider-aware enablement and pending-request behavior. |
| [Web inline consent notice](../../menofhunger-www/components/app/AiConsentNotice.vue) | Update destination copy within the existing compact interaction. |
| [Web consent host](../../menofhunger-www/components/app/AiConsentHost.vue) | Keep notices attached to the active surface. |
| [Web contract checks](../../menofhunger-www/types/api-contract-check.ts) | Catch API/client field drift. |
| [iOS Marv service](../../menofhunger-ios/MenOfHunger/Domain/Marv/Feature/CatchUp/Services/MarvService.swift) | Native API transport and response handling. |
| [iOS Marv account model](../../menofhunger-ios/MenOfHunger/Domain/Marv/Feature/CatchUp/Model/MarvinMe.swift) | Decode any new member-facing configuration fields. |
| [iOS consent store](../../menofhunger-ios/MenOfHunger/Domain/Marv/Feature/CatchUp/Model/AIConsentStore.swift) | Provider-aware permission and state transitions. |
| [iOS inline consent notice](../../menofhunger-ios/MenOfHunger/Domain/Marv/Feature/CatchUp/Screens/AIConsentNotice.swift) | Keep provider copy and interaction consistent with web. |
| [Men of Hunger UI Library](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN) | Design new admin and disclosure states before UI implementation. |
| [Admin experience guidance](admin-experience.md) | Fit additions into the existing admin structure. |

### Regression tests to extend

| Existing test | Coverage to preserve or expand |
| --- | --- |
| [AI service tests](../src/modules/marvin/services/marvin-ai.service.spec.ts) | Request shaping, response parsing, tools, deadlines, and usage. |
| [Routing tests](../src/modules/marvin/services/marvin-routing.service.spec.ts) | Mode behavior with provider mappings. |
| [Prompt builder tests](../src/modules/marvin/services/marvin-prompt-builder.service.spec.ts) | Shared persona, source context, and prompt versions. |
| [Public reply tests](../src/modules/marvin/jobs/marvin-public-reply.processor.spec.ts) | Saved replies, controlled failure, refunds, and idempotency. |
| [Private reply tests](../src/modules/marvin/jobs/marvin-private-reply.processor.spec.ts) | Conversation isolation, continuation, and successful delivery. |
| [Catch-up tests](../src/modules/marvin/services/marvin-catch-up.service.spec.ts) | Catch-up generation and failure behavior. |
| [Tool handler tests](../src/modules/marvin/services/marvin-tool-handlers.service.spec.ts) | Authorization survives provider substitution. |
| [Post access tests](../src/modules/marvin/services/marvin-post-access.spec.ts) | Audience and permission boundaries. |
| [Consent tests](../src/modules/marvin/services/ai-consent.spec.ts) | Correct human identity and provider permission. |
| [Credit tests](../src/modules/marvin/services/marvin-credit.service.spec.ts) | Single member charge/refund settlement. |
| [Usage tests](../src/modules/marvin/services/marvin-usage.service.spec.ts) | Provider attribution and cost normalization. |
| [Admin settings tests](../src/modules/marvin/services/marvin-admin.service.spec.ts) | Effective configuration and versioned settings. |
| [Admin gating tests](../src/modules/marvin/marvin-admin-gating.spec.ts) | Server-enforced admin-only access. |
| [Web inline consent tests](../../menofhunger-www/tests/ai-consent-inline.test.ts) | Compact disclosure and request coordination. |
| [Web consent state tests](../../menofhunger-www/tests/ai-consent.test.ts) | Enablement, cancellation, and provider transitions. |
| [Web catch-up lifecycle tests](../../menofhunger-www/tests/marv-catch-up-lifecycle.test.ts) | Loading and terminal states. |
| [iOS release contract tests](../../menofhunger-ios/MenOfHungerTests/ReleaseContractTests.swift) | Cross-platform response decoding and compatibility. |
| [iOS local check runner](../../menofhunger-ios/scripts/check.sh) | Existing native lint/format/check entry point. |

Operational starting points: [debugging missing replies](marv-reply-debugging.md), [CLI/MCP setup and read-only diagnostics](../tools/mcp/README.md), [local release procedure](local-release-checks.md), [API contracts](api-contract.md), and [the canonical validation matrix](engineering-policy.md#validation-matrix).
