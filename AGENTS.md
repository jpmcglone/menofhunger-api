# Men of Hunger — API

Work directly on `main` in this repository. Do not create a feature branch or a new worktree unless the user explicitly requests one.

Read the relevant sections of [engineering policy](docs/engineering-policy.md) for validation,
product/design decisions, realtime, media ownership, dependencies, and server/deploy boundaries.
Preserve unrelated changes and inspect the nearest implementation before editing.

Use `.agents/skills` when the task needs that workflow; `.cursor/rules` holds scoped project
constraints readable by Codex and Cursor. Do not load every file. Shared policy, contract/design/
marketing skills, and shared rule bodies are maintained in the API repository. Update mirrors
with its `scripts/sync-agent-guidance.py`, passing the active `--ios-root` for an iOS worktree.
Edit canonical sources rather than mirrors. Paths are relative to the owning repository.

## API essentials

For live company checks, prefer the Men of Hunger MCP tools, or `npm run --silent moh -- tools --json` when the catalog is stale. Read [CLI/MCP guidance](tools/mcp/README.md). Never inspect credential files or ask for session tokens or OTP codes. The user signs in with `npm run moh -- login`. Drafts and decisions are local-only.

NestJS + Prisma. Controllers return `{ data }` or `{ data, pagination }`. Errors use the global exception filter. Define responses in the owning DTO, validate inputs with Zod, and use injected configuration. Non-admin users receive 404 on admin routes.

Mutations commit first, emit realtime changes, then dispatch notification, push, and email fan-out through `SideEffectsService`. Keep permission-critical results on the request path. Do not introduce module cycles or conceal them with `forwardRef()`.

For schema changes, review the migration SQL and verify the database target before applying it locally. Regenerate Prisma and API contracts, then synchronize web types and iOS decoding.

For every new or changed media upload, embed, or generated derivative, follow the [media ownership and review policy](docs/engineering-policy.md#media-ownership-and-review), including the API media-review resolver and orphan-deletion regression coverage.

Use the [validation matrix](docs/engineering-policy.md#validation-matrix) for completion checks.
