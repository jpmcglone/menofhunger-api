# Engineering policy

Authoritative source: `menofhunger-api/docs/engineering-policy.md`. Web and iOS carry
identical checked copies so a standalone checkout works in both Codex and Cursor.
Edit the source, then run `python3 scripts/sync-agent-guidance.py` in the API repository.
Use `--check` to detect drift; no background process or editor-specific skill copies.

## Scope and precedence

Follow explicit user scope and authorization. A review request defaults to findings;
an implementation request authorizes implementation, including both platforms when requested.
Infer platform from the task and open code; ask only when missing information changes the work.
Do not turn skill defaults into an extra approval step. Preserve unrelated working-tree changes.
Report the outcome, relevant evidence, and unresolved limitations concisely. Tables are optional.

## Dependencies

Preserve installed dependency and API versions during ordinary feature work. Evaluate upgrades
as a separate task or when explicitly requested. For upgrades, verify current official migration
guidance and compatibility, choose a deliberate target, update lockfiles, and test the migration.
A vendor skill's suggestion to use the latest SDK does not authorize an incidental upgrade.

## Product and visual decisions

Simplicity is a design heuristic, not a quota: remove an element only when evidence shows it is
redundant, harmful, or outside the agreed scope. Preserve useful behavior and accessibility.
Use existing components and semantic tokens first. Borders/dividers separate content; shadows
express real elevation such as popovers. Neither universally replaces the other. Dense feeds
remain edge-to-edge. Add a semantic token only when the existing system cannot express a needed
state or accessible distinction, and apply it consistently across supported themes.
Prefer short labels, visible affordances, and native platform patterns. Heuristics about toolbar
counts, modifier lengths, animation values, and word counts are prompts for judgment, not hard
limits. Correctness, security/privacy, and accessibility take precedence over visual minimalism.

## Realtime contracts and ownership

Choose the payload from the operation:
- A snapshot/new entity reuses the canonical HTTP DTO, filtered for the recipient's permissions.
- A partial update uses an explicitly named, typed patch: identity plus changed fields. Reuse
  field types; do not pretend a patch is a complete DTO. Omitted means unchanged; explicit null
  means cleared. Test that distinction wherever the transport allows clearing values.
- A removal carries identity. An invalidation carries the scope needed for a bounded refetch.

Do not send the entire resource on every counter change, or require a refetch for every event.
Patch known state idempotently; deduplicate mutation/socket echoes. Refetch when reconnecting,
on activation when stale, or when a patch cannot safely recompute an aggregate. Coalesce bursts
and ignore stale responses after identity/account changes. Never infer private fields or totals
from a partial payload. Authorization must hold for every recipient, not only the HTTP actor.

Use one injected transport per app. Screens may subscribe to typed injected publishers and own
simple lifecycle orchestration. Reusable reducers, cross-store effects, and complicated merge
logic belong in services/controllers/stores. Screens must not create private sockets or parse
raw transport messages. Clean up subscriptions and pending work with their owner.

## Development processes

The user owns persistent dev servers and watchers; do not start, restart, or kill them without
an explicit request. A bounded automated test may launch an isolated preview server on a free
port, with cleanup on success, failure, and interruption. Prefer an existing compatible server.
Never kill a process merely because it occupies a port. Builds and checks must not rewrite
source implicitly; use explicit fix commands for formatting. Preserve unrelated edits.

## Validation matrix

This is the only task-to-check matrix. Rules and skills link here instead of restating it.
Run focused checks while iterating, then one applicable final gate. Reuse successful results
when the relevant code has not changed. Do not repeat a build's prebuild checks separately.

| Change | Focused verification | Final verification |
| --- | --- | --- |
| Guidance/docs only | Metadata, relative links, policy sync (`--check`); shell syntax if scripts change | No app build or test suite solely for prose |
| Web copy/style, no behavior | Lint changed files; inspect affected UI | Broaden only for unresolved risk |
| Web behavior, rendering, contracts, or config | Relevant unit/component tests; targeted lint/types as needed | `npm run lint`, then `npm run build` (prebuild includes typecheck, contract validation, all unit tests) |
| Web SSR/hydration | Compare server HTML and first client render; exercise the changed route | Above web gate plus `npm run check:hydration`; include affected public routes, and authenticated paths when applicable |
| API behavior/config | Relevant tests and typecheck as needed | `npm run lint`, `npm run build:typecheck`, `npm run build` (module graph included), `npm test -- --runInBand` |
| Prisma/schema | Generate and review SQL; verify target before applying locally; regenerate client/contracts first | API gate once after generation, plus affected consumer checks; never apply production migrations as an implicit test |
| Swift copy/layout with no state/type change | Format changed source AND tests, strict formatter/SwiftLint; inspect UI | Build if compile risk; no full suite for a trivial visual change |
| Swift behavior, model, transport, or project config | Changed-file format/strict lint plus relevant tests | `./scripts/check.sh` once (read-only source checks, build, tests), or equivalent individual steps |
| Navigation, scrolling, keyboard, sheets, UIKit bridges | Above platform checks | Focused simulator/browser interaction including the changed failure/edge state |
| Shared contract/event | DTO plus both client decoding/merge tests for changed consumers | Respective platform gates; exercise missing/null, audience filtering, and echo deduplication when relevant |

Swift focused commands (from the iOS root):
```sh
xcrun swift-format format --in-place --configuration .swift-format <changed Swift files>
xcrun swift-format lint --strict --configuration .swift-format <changed Swift files>
swiftlint lint --strict -- <changed Swift files>
```
`./scripts/check.sh --fix` explicitly applies whole-tree fixes; default checks never mutate source.
Swift style and narrow exceptions are defined only in `menofhunger-ios/STYLEGUIDE.md`; executable
format/lint configuration owns mechanical settings. Import sorting is handled by SwiftLint.

Use meaningful behavior tests for regressions, not regex tests that merely mirror a chosen
implementation. Keep existing useful checks; update an outdated invariant rather than deleting
a failure. Fix introduced warnings; identify pre-existing failures precisely. A build alone does
not prove UI behavior, and a skipped/blocked test is not a pass. Report actual test counts.
