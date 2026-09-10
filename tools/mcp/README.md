# Men of Hunger CLI and MCP

One shared tool catalog for the founder, scripts, and AI assistants. The CLI and
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
Dependencies are pinned in the nested package lock. The API's hosted MCP loads
this same package. The root install's postinstall runs `mcp:setup` automatically
on native Render, Docker, CI, and local installs. If lifecycle scripts were
intentionally disabled, run `npm run postinstall` before starting the API.

## Connect Cursor and Codex

```sh
npm run moh -- configure
```

This registers the local stdio server as `menofhunger` (or `menofhunger-local`)
with its absolute source path and your API/state-directory settings. It only
changes the Men of Hunger MCP entry. Cursor is written to the user config
`~/.cursor/mcp.json`. Codex uses `codex mcp add` when `codex` is on PATH; the
ChatGPT Codex app reads the same servers from `~/.codex/config.toml`. The
command succeeds when either client is registered. `node` must be on PATH.
Re-run configure if you move the repository or intentionally change environments.
Refresh MCP tools or start a new Cursor or Codex session if the current session
still has its old tool catalog. Configuration alone does not authenticate the
account.

Do not add a project `.cursor/mcp.json` for this server. Absolute machine paths
do not belong in the repository.

### Connect Cursor

`configure` writes the user-level Cursor file. Equivalent manual registration,
merged into any existing `mcpServers`:

```json
{
  "mcpServers": {
    "menofhunger": {
      "command": "node",
      "args": ["/absolute/path/menofhunger-api/tools/mcp/src/server.mjs"],
      "env": {
        "MOH_API_BASE_URL": "https://api.menofhunger.com/v1",
        "MOH_MCP_STATE_DIR": "/Users/you/.local/share/menofhunger-mcp"
      }
    }
  }
}
```

You can also add the same stdio server from Cursor Settings → MCP. Reload MCP
tools or start a new chat after changing the file.

### Connect Codex

Equivalent CLI registration, when `codex` is on PATH:

```sh
codex mcp add menofhunger -- node /absolute/path/menofhunger-api/tools/mcp/src/server.mjs
```

If the CLI is missing, add the same stdio server to `~/.codex/config.toml`:

```toml
[mcp_servers.menofhunger]
command = "node"
args = ["/absolute/path/menofhunger-api/tools/mcp/src/server.mjs"]

[mcp_servers.menofhunger.env]
MOH_API_BASE_URL = "https://api.menofhunger.com/v1"
MOH_MCP_STATE_DIR = "/Users/you/.local/share/menofhunger-mcp"
```

Other MCP clients can launch `node` with the same absolute server path over stdio.
Run the server directly rather than through npm: stdout is reserved for MCP JSON-RPC.
The desktop uses stdio; ChatGPT web uses the hosted HTTPS connection below.
Both are private administrator integrations, not ordinary member integrations.

## Connect ChatGPT web

The server runs **inside the existing API**, at **`https://api.menofhunger.com/mcp`**,
using MCP Streamable HTTP. There is no separate process, service, DNS record, or
OpenAI API key to manage for the hosted server. It works while your laptop is off.
`https://menofhunger.com` is the website, not the MCP endpoint.

After the API changes are deployed:

1. Sign in to [Men of Hunger](https://menofhunger.com) with your own site administrator account.
2. In ChatGPT, enable **Settings → Security and login → Developer mode** if needed.
   Availability depends on your account/workspace policy.
3. Add a connection from ChatGPT's Plugins page. Name it **Men of Hunger**, use
   **`https://api.menofhunger.com/mcp`**, and choose **OAuth** if authentication is requested.
   Client registration is automatic; leave optional client ID/secret fields blank.
4. On the Men of Hunger consent page, choose **Allow read access**. If it asks you
   to sign in, open the website from that page, sign in, then return and continue.
5. Start a conversation, enable the connection in the tools menu, and ask:
   **“Give me a Men of Hunger briefing and three priorities, with evidence.”**

The web connection exposes the **19 read tools**. The four local draft/decision
file tools stay on the desktop/CLI; ChatGPT web can draft and reason in the conversation.
Desktop login and web OAuth are separate sessions. Disconnecting the web connection
revokes its dedicated session without signing you out of the website or CLI.
Reconnect after the 30-day authorization expires. Refresh the connection in ChatGPT
after a deployment changes the tool catalog.

Official setup reference: [Connect and test an MCP connection](https://developers.openai.com/plugins/deploy/connect-chatgpt).

### Hosted implementation and deployment

The API mounts `/mcp`, `/mcp/consent`, `/authorize`, `/token`, `/register`, `/revoke`,
`/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource/mcp`
at the document root. These standard protocol responses do not use the REST `{ data }`
envelope or `/v1` prefix. All business reads still pass through the existing `/v1/admin`
controllers, guards, rate limits, and canonical services.

It uses the existing Redis service, `SESSION_HMAC_SECRET`, public API URL
`BROWSER_HANDOFF_BASE_URL` (production: `https://api.menofhunger.com/v1`), and frontend
origin configuration. No database migration or new secret is required. Redis holds
encrypted OAuth state; clearing it or rotating the session secret requires reconnecting.
The deployment must preserve these root paths and avoid caching their responses.
The API runtime requires Node 20.19+; the Docker image includes the shared package.

Authorization uses the official MCP SDK's OAuth endpoints and PKCE S256. Client
callbacks are restricted to ChatGPT's `/connector/oauth/<callback_id>` or
`/connector_platform_oauth_redirect` HTTPS URLs. Codes are single-use (2 minutes),
access tokens last up to 15 minutes, and rotating refresh tokens expire with the
30-day grant. The bearer token is scoped to `moh:read` and this endpoint; it is never
a raw product session token. Existing admin session policy is checked at consent,
redemption, refresh, and MCP requests. The shared admin guards also check each API read.

Read-only deployment checks (no credentials needed):

```sh
curl --fail https://api.menofhunger.com/.well-known/oauth-protected-resource/mcp
curl --fail https://api.menofhunger.com/.well-known/oauth-authorization-server
curl -i https://api.menofhunger.com/mcp
```

The first two should return metadata. The last should return **401** with a
`WWW-Authenticate` header pointing at the resource metadata. A 404 means this version
is not deployed or the proxy is not forwarding the route. These checks prove discovery;
the final authenticated ChatGPT handshake requires your own consent in the browser.

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

## Publish as your account or an operated page (desktop/CLI)

The local MCP provides `publishing_accounts`, `publish_post`, and `get_post`.
Publishing must be explicitly requested by the user. Resolve the account first:

```sh
npm run --silent moh -- accounts --json
npm run --silent moh -- publish --input post.json --json
npm run --silent moh -- post POST_ID --json
```

`post.json` contains an explicit author and the complete text, including source links:

```json
{
  "authorUsername": "mohnews",
  "visibility": "public",
  "body": "A concise, verified news summary. Source: https://example.com/news"
}
```

Posts are top-level text posts with `visibility`: `public` (default), `verifiedOnly`,
`premiumOnly`, or `onlyMe`. The normal API checks verification and membership for
the selected account and returns its permission error; the tool never widens the
audience on failure. Posts are limited to the account’s normal limit, up to 1,000
characters including URLs.
Only the administrator's own account and pages they already operate are accepted.
For pages, the tool uses the existing account switch endpoint, verifies the page
and operator, publishes through the normal post API (including normal realtime
and notification handling), then restores and verifies the personal admin session.
No API deployment, permission grant, page impersonation, or browser cookie extraction
is needed. Refresh the desktop MCP catalog to see newly added tools; the CLI uses
the same implementation immediately.

A per-environment lock prevents concurrent publishing from mixing identities.
Do not switch accounts, log in, or log out in another CLI during publishing.
If a process is interrupted, check the author's feed for a created post, sign in
again, and remove only the stale `publishing-lock-*.json` for that environment
from the private state directory. Do not inspect or copy credential files.
No publish request is automatically retried. A connection failure may happen
after creation; inspect the feed before retrying. A confirmed post with a session
restoration failure returns `published: true` plus a warning to sign in again.

The hosted OAuth connector and in-product MARV retain their read-only shared tool
catalog. Existing `moh:read` grants do not acquire publishing access.

## Environments and credentials

Production is the default for operating the company. Localhost is useful for
testing new API/MCP code against your development database before deployment.
The local website is `http://localhost:3000`, but its API is
`http://localhost:3001/v1`. The production website is `https://menofhunger.com`,
but its API is `https://api.menofhunger.com/v1`. MCP uses those API addresses.

```sh
moh --env prod login
moh --env prod briefing
moh --env local login
moh --env local status
moh --env local configure
```

`--env local` selects localhost:3001 and registers `menofhunger-local` when used
with configure. `--env prod` registers `menofhunger`. They have separate login
sessions and local records, and every tool result identifies its environment.
An explicit `--env` overrides `MOH_API_BASE_URL`. The MCP launches on demand;
neither instance starts a development API server. You can leave local unconfigured
unless you want it in the AI tool catalog.

The local API also serves `http://localhost:3001/mcp`. ChatGPT web cannot reach your
computer's localhost directly; testing there requires a tunnel with reachable OAuth
URLs. For normal operations, connect web to production and use the desktop/CLI local
profile to test development changes. There is no need to set up a tunnel for daily use.

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
existing administrator privileges; the desktop MCP exposes an explicit read
allowlist, local file writes, and visibility-controlled posting as the administrator or an operated page. Contact/credential fields are removed from tool
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
monitoring, and unsupported writes. These need their actual source integrations or
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
Hosted tests exercise HTTP MCP initialization/tool calls, OAuth discovery, consent,
CSRF, PKCE, callback/resource binding, single-use codes, refresh rotation, revocation,
admin access removal, encrypted state, and exclusion of desktop filesystem tools.

## In-product admin MARV

Web and iOS discover the same admin catalog through `admin_capabilities`. The new
`admin_workspace` tool reads additional named admin areas; use `moh call
admin_workspace '{"workspace":"verification"}' --json` or discover its schema with
`moh tools --json`. The dedicated admin assistant reuses these read tools and has
12 additional proposal operations that require an in-product confirmation button.
MCP and the CLI do not execute those mutations. Local draft/decision files remain local.
See [admin experience and coverage](../../docs/admin-experience.md).

### Attention and member activation

`moh workspace attention` and `moh briefing` return the weekly member-reply pulse
(personal accounts only: 24-hour human replies, later-day author return, lodge prompt
replies, oldest verification wait) plus pending admin work and a bounded preview of
unanswered public conversations. Member posts are listed first in that preview.
`moh activation --days 90 --stage verified` explores the full signup
cohort and lists members who have verified but have not yet contributed publicly. Use
`--offset 25 --limit 25` for another page. Supported windows are 30 and 90 days; stage is the
highest observed milestone (`joined`, `verified`, `contributed`, `returned`). Counts remain
for the entire cohort while member rows are filtered. See the returned definitions before
comparing with older analytics activation percentages.

These reads share the product admin API. Personal member actions are reviewed in the
member's private MARV chat; they do not grant the external MCP or CLI mutation permissions.

### Immediate posts in Ask MARV

“Post now” uses a direct `post_publish` proposal with body, visibility, and optional
authorUsername. The Publish now review button calls the existing post service once;
it does not create a scheduled job. The proposal binds the acting account at review
and rechecks page-operation rights at confirmation. API permission errors remain
failed receipts with their normal message. Unknown transport outcomes are never retried.
Only explicit future or recurring work uses delegated jobs. For once schedules, `at`
is an absolute instant; without `at`, work begins when the job is created. Recurring
`time` and `weekday` defaults do not apply to a once schedule.
