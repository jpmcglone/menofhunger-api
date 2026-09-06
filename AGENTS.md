# Men of Hunger — API

## Working agreement

Read [engineering policy](docs/engineering-policy.md) for scope, dependency versions,
product decisions, realtime contracts, process ownership, and the canonical validation matrix.
Preserve unrelated working-tree changes and inspect the nearest implementation before editing.

## Guidance layout

This is the shared entry point for Codex and Cursor. Repository skills live in `.agents/skills/<name>/SKILL.md`; read a skill when its description matches the task. Do not copy skills into editor-specific folders.

Detailed rules remain in `.cursor/rules/` as a single source. Cursor can attach them by glob or description; Codex should read the relevant files from the table below before editing that area. Do not load every rule or skill for every task. Paths in rules are relative to this repository unless a sibling repository is named.

## API essentials

NestJS + Prisma. Controllers return `{ data }` or `{ data, pagination }`; errors use the global exception filter. Define responses in the owning DTO, validate inputs with Zod, and use injected configuration. Non-admin users receive 404 on admin routes.

For mutations, commit first, emit realtime changes, and dispatch notification/push/email fan-out through `SideEffectsService`. Keep permission-critical results on the request path. Do not introduce module cycles or use `forwardRef()` to conceal them.

For schema changes, review migration SQL and verify the database target before applying locally. Regenerate Prisma and API contracts, then synchronize web types and iOS decoding.

Use the [validation matrix](docs/engineering-policy.md#validation-matrix) for completion checks.

## Read the applicable detailed rules

| Task or concern | Rule |
| --- | --- |
| menofhunger-api core conventions (Nest + Prisma) | [00-project-overview](.cursor/rules/00-project-overview.mdc) |
| Apply the Men of Hunger product simplification algorithm before adding or changing API behavior | [10-product-algorithm](.cursor/rules/10-product-algorithm.mdc) |
| Keep feed concepts consistent across API, web, and iOS | [15-feed-surface](.cursor/rules/15-feed-surface.mdc) |
| Delete safely by checking cross-platform callers and choosing delete, redirect, handoff, or deprecate | [20-deletion-deprecation](.cursor/rules/20-deletion-deprecation.mdc) |
| Do not start dev servers/watchers (user runs them). | [25-no-dev-servers](.cursor/rules/25-no-dev-servers.mdc) |
| Keep local and CI loops fast; add automation only after simplifying the surface | [30-local-loop](.cursor/rules/30-local-loop.mdc) |
| Definition of done for substantive api features (lint, types, tests, build, prisma, contracts) | [40-feature-done-checklist](.cursor/rules/40-feature-done-checklist.mdc) |
| Spaces / Watch Party gateway architecture for PresenceGateway. Read when working on watch party sync, owner socket tracking, presence.gateway.ts, or WatchPartyStateService. | [50-spaces-gateway](.cursor/rules/50-spaces-gateway.mdc) |
| Keep notification rows and lock-screen push copy human-readable and free of internal identifiers | [55-notification-copy](.cursor/rules/55-notification-copy.mdc) |
| Bell badge is unseen; list highlight is unread. Do not mix deliveredAt and readAt. | [56-notification-seen-vs-read](.cursor/rules/56-notification-seen-vs-read.mdc) |
| Real-time first — every state change worth showing across pages/users must emit a websocket event in addition to the HTTP response. | [60-realtime-first](.cursor/rules/60-realtime-first.mdc) |
| Post-commit work (notifications, pushes, fan-out, emails) goes on the side-effects queue via SideEffectsService.dispatch — never inline on the request path, never setImmediate. | [65-async-side-effects](.cursor/rules/65-async-side-effects.mdc) |
