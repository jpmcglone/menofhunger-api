# Men of Hunger CLI and MCP

One shared set of 20 tools for the founder, scripts, and AI assistants. The CLI and
MCP share validation, API calls, authentication, redaction, and local persistence.
They use the existing Men of Hunger API; the host AI does the reasoning. No extra
OpenAI API key, model call, or database connection is required.

## Start here

From the API project, with Node 20.19+ installed:

```sh
npm run mcp:setup
npm run moh -- login
npm run moh -- status
npm run moh -- briefing
```

Login asks for your existing administrator account's phone number and SMS code,
with both inputs hidden. Use your own account, not an impersonated or page
session. Login uses the product's existing phone authentication and verifies the
existing admin guard. It does not extract or reuse a browser's cookies.

For a short `moh` command available anywhere, optionally install the local package:

```sh
npm install --global ./tools/mcp
moh help
moh briefing --range 7d
```

Without a global install, use `npm run --silent moh -- ...` from the API project.
Dependencies are pinned in the nested package lock and remain separate from the
production API runtime.

## Connect Codex

```sh
npm run moh -- configure
```

This registers the local stdio server as `menofhunger` using `codex mcp add`, its
absolute source path, and your API/state-directory settings. It only changes the
Men of Hunger MCP entry. Both `codex` and `node` must be on PATH. Re-run configure
if you move the repository or intentionally change environments. Refresh MCP
tools or start a new Codex session if the current session still has its old tool
catalog. Configuration alone does not authenticate the account.

Equivalent manual registration:

```sh
codex mcp add menofhunger -- node /absolute/path/menofhunger-api/tools/mcp/src/server.mjs
```

Other MCP clients can launch `node` with the same absolute server path over stdio.
Run the server directly rather than through npm: stdout is reserved for MCP JSON-RPC.
This is a local desktop integration, not a public remote OAuth server for ChatGPT
web or an integration that ordinary members can install.

Ask your assistant:

- “Give me a Men of Hunger briefing and three priorities, with evidence.”
- “Investigate why this member has a subscription but cannot access Premium.”
- “Review retention, showing sample sizes and only mature cohorts.”
- “Find unanswered public posts from the last week.”
- “Draft a newsletter from public discussions, and save it for review.”
- “Record this decision, its evidence, success measure, and review date.”

The server includes four prompts (`morning_briefing`, `membership_investigation`,
`weekly_decisions`, `community_digest`) and two resources (`moh://guide`,
`moh://metrics`). These are on-demand workflows, not scheduled jobs.

## CLI examples

```sh
npm run --silent moh -- analytics --area retention --range 30d
npm run --silent moh -- members "username or name" --limit 10
npm run --silent moh -- member username
npm run --silent moh -- diagnose MEMBER_ID
npm run --silent moh -- feedback --status new --category bug --limit 10
npm run --silent moh -- reports --status pending
npm run --silent moh -- queues
npm run --silent moh -- health
npm run --silent moh -- content --unanswered --limit 20
npm run --silent moh -- content --since 2026-09-01T00:00:00Z --before 2026-09-05T00:00:00Z
npm run --silent moh -- decisions
```

Discover exact input schemas rather than guessing arguments:

```sh
npm run --silent moh -- tools --json
npm run --silent moh -- analytics --help --json
npm run --silent moh -- call analytics '{"area":"retention","range":"30d"}' --json
```

`--json` produces one `{ "ok": true, "data": ..., "error": null }` object.
Failures exit with code 1 and return `{ "ok": false, "data": null, "error": ... }`.
Status with `connected: false` is a successful readiness check, not a failed tool
invocation. Partially available briefings return per-section availability; an
entirely unavailable briefing fails. Npm's `--silent` keeps its own banners out
of machine output. Use `moh` directly after a global install for the same effect.

Pagination uses `pagination.nextCursor`. Pass the same filters with `--cursor`.
For content, also carry the returned `since` and `before` to hold the interval
fixed. A stale content cursor requires restarting that query. The CLI never
silently crawls an unlimited number of members or posts.

Save larger structured inputs using `--input FILE`. Examples are in `examples/`:

```sh
npm run --silent moh -- decision --input tools/mcp/examples/decision.json
npm run --silent moh -- draft --input tools/mcp/examples/draft.json
```

Replace sample evidence with real observations before recording a decision.
Drafts and decisions live only on this computer, separated by API environment.
Saving a decision does not execute it or schedule its review. Drafts are plain
text/Markdown artifacts, not live newsletter records.

## Environments and credentials

| Variable | Default |
| --- | --- |
| `MOH_API_BASE_URL` | `https://api.menofhunger.com/v1` |
| `MOH_MCP_STATE_DIR` | `~/.local/share/menofhunger-mcp` |

Use HTTPS for remote APIs. HTTP is accepted only on loopback hosts. A local API
can be selected with `MOH_API_BASE_URL=http://127.0.0.1:3001/v1`; the user runs the
development server. Credentials are bound to the exact API URL and expire/renew
using the existing server session lifecycle. Run `moh login` again if the session
is expired or revoked. `moh logout` revokes the session through the existing
logout route and deletes the local credential. If the API is offline, the local
credential is still removed and the CLI reports failed server revocation.

Session files use mode 600 in a directory with mode 700. Do not commit, copy into
prompts, or inspect those files with AI tools. The session has the account's
existing administrator privileges; the MCP exposes only its explicit read
allowlist plus local file writes. Contact/credential fields are removed from tool
results, but free-text support content can still contain member-provided personal
information. Treat support and moderation results as internal.

## API additions and rollout

Existing analytics, referrals, account lookup, grants, feedback, reports,
newsletters, and queue tools use the current admin API after login. Three
new read-only endpoints require deploying the accompanying API changes:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/admin/operations/members/:id` | Canonical product billing plus recorded Stripe/Apple state and account/activity flags |
| `GET /v1/admin/operations/health` | Support/report totals, received-but-unprocessed webhook age, scheduled-post failures |
| `GET /v1/admin/operations/content` | Bounded public content search, including unanswered posts |

They use `AdminGuard` and the same `{ data, pagination? }` envelope. Non-admin and
impersonated sessions receive 404. Member diagnostics call `BillingService.getMe`;
they do not recompute entitlements or query payment providers. Content excludes
groups, restricted/private posts, drafts, deleted posts, and bot/banned authors.
No migration or new API secret is needed. Contract DTOs and the web mirror are
synchronized; iOS does not consume these new endpoints.

After deploying the API, run `moh status`, `moh health`, and `moh content --limit 1`
to verify readiness. The briefing retains available sections when an optional
endpoint is not yet deployed.

Not connected in this version: payment receipts/revenue accounting, release
history, HTTP error tracking, mobile crashes, member-facing OAuth, scheduled
monitoring, and external writes. These need their actual source integrations or
separately scoped tools. The integration never infers those facts from unrelated
metrics. See `moh definitions` for metric-specific limits.

## Validation

```sh
npm run mcp:test
npm run lint
npm run build:typecheck
npm run build
npm test -- --runInBand
```

MCP tests exercise an actual child-process stdio handshake, tool/resource/prompt
discovery, input validation, CLI JSON output, credential isolation and renewal,
redaction, partial failures, cohort maturity, and local records. API HTTP tests
exercise the real admin guard and controller routes with mocked domain services
on an ephemeral loopback port. CI installs the nested package and runs its tests.
