# Figma gaps closed — 2026-10-08 (API)

Figma was updated first and remains the source of truth; newer Oct 8 designs win.

## Figma frames updated
- Page 04: `1220:1787`, `1322:17492`, `1322:19566`
- Page 23: `1322:19569`, `1322:19576`, `1322:19583`, `1322:19590`, `1322:19597`
- Page 18: `1322:45357`
- Page 24: `1139:169`, `1322:45371`

## What shipped
- Scheduled posts crosspost to Pickax/X at fire time (X no longer skipped for scheduled source), with regression tests.
- Channel inline quoted reply support; admin image-review references token with a 409 `references_changed` on delete; docs updated.

## Validation
See the validation matrix in `docs/engineering-policy.md`. Lint, typecheck, build, contract check, and full Jest passed.
