# Men of Hunger — API

Read [engineering policy](docs/engineering-policy.md) for scope, dependency versions, product decisions, realtime contracts, and the validation matrix. Preserve unrelated working-tree changes. Inspect the nearest implementation before editing.

Skills live in `.agents/skills/<name>/SKILL.md`. Read a skill when its description matches the task. Do not copy skills into editor-specific folders. Shared skills (`api-contract-sync`, `design-simplicity-principles`, `moh-designer`, `moh-marketing`, `ux-review`) and shared rules `15-feed-surface`, `20-deletion-deprecation`, and `56-notification-seen-vs-read` are canonical in this repository. Interface-polish references are canonical in web. `60-realtime-first` is platform-specific. Sync copies with `scripts/sync-agent-guidance.py`. Do not edit a mirror independently.

Detailed rules are in `.cursor/rules/`. Read a rule when its description matches the task. Do not load every rule or skill. Paths are relative to this repository unless a sibling repository is named.

## API essentials

For live company checks, prefer the Men of Hunger MCP tools, or `npm run --silent moh -- tools --json` when the catalog is stale. Read [CLI/MCP guidance](tools/mcp/README.md). Never inspect credential files or ask for session tokens or OTP codes. The user signs in with `npm run moh -- login`. Drafts and decisions are local-only.

NestJS + Prisma. Controllers return `{ data }` or `{ data, pagination }`. Errors use the global exception filter. Define responses in the owning DTO, validate inputs with Zod, and use injected configuration. Non-admin users receive 404 on admin routes.

Mutations commit first, emit realtime changes, then dispatch notification, push, and email fan-out through `SideEffectsService`. Keep permission-critical results on the request path. Do not introduce module cycles or conceal them with `forwardRef()`.

For schema changes, review the migration SQL and verify the database target before applying it locally. Regenerate Prisma and API contracts, then synchronize web types and iOS decoding.

For every new or changed media upload, embed, or generated derivative, follow the [media ownership and review policy](docs/engineering-policy.md#media-ownership-and-review), including the API media-review resolver and orphan-deletion regression coverage.

Use the [validation matrix](docs/engineering-policy.md#validation-matrix) for completion checks.
