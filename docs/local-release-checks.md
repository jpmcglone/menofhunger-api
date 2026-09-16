# Local release checks

Run these before pushing a coordinated API, web, and iOS change. GitHub Actions only
runs lint/format checks. Render installs dependencies and builds the app; it does
not run the local test suites. A successful deploy is not release validation.

| Repository | Command | Coverage |
| --- | --- | --- |
| API | `npm run check` | Shared guidance, lint, TypeScript, generated contracts/fixtures, production build, module graph/admin coverage, unit tests, HTTP tests, MCP tests, disposable PostgreSQL upgrade/data tests |
| Web | `SENTRY_UPLOAD=false npm run check` | Lint, Vue/TypeScript, API type wiring, Vitest, production build |
| iOS | `./scripts/check.sh` | App Store preflight, strict formatting/lint, simulator compilation, XCTest/Swift Testing, static source scan |

Use each repository's `.nvmrc`. The API database check requires running Docker.
Media checks require FFmpeg with the `zscale` filter; on macOS install
`ffmpeg-full`. The API check selects that binary for its own process without
changing the machine's default FFmpeg. Missing prerequisites fail the check.

iOS tests run serially because several exercise real windows, keyboard focus, and
shared UIKit state. Set `DESTINATION="platform=iOS Simulator,id=<UUID>"` to select
a specific installed device. Release compilation and the signed archive/upload
remain separate steps; simulator success does not verify distribution signing.

For a local unsigned device Release build, from the iOS repository run:

```sh
./scripts/check-release.sh
```

`SENTRY_UPLOAD=false` skips the Sentry source/symbol upload for this validation
build. Normal Release archives retain their existing symbol-upload behavior.

## Cross-platform contracts

The API owns `src/common/dto/contract-fixtures.ts`. Its typed fixtures include
seven billing states, MARV consent, and account-deletion receipts. API billing
tests compare real serializer output with those fixtures. Web tests consume them
through the billing composable. iOS tests decode the same JSON through the
production codec, including optional/null/unknown-field behavior.

After an intentional contract change, run `npm run emit:contracts` and
`npm run sync:contract-fixtures` from the API, review all generated client changes,
and run the relevant client tests. `npm run check:contracts` checks for drift
without rewriting files. Keep sibling checkouts present for cross-repo checks;
a standalone API checkout can only check its own generated files.

## Purchase and database coverage

Automated cases cover verification before purchase, cancellation, pending
approval, API activation failure, unfinished transaction retry without rebuying,
restore failure/recovery, web checkout polling, renewal, expiry, refund,
revocation, and retry after a partially persisted notification. Tests use
synthetic transactions and injected transports, not real purchases. Apple-signed
sandbox purchase/restore still needs device testing.

`npm run check:database` creates a disposable PostgreSQL container and ignores
the developer's database URL. It upgrades the pinned historical schema, verifies
schema parity and preservation of a synthetic account, and tests full relational
erasure, concurrent coin debits, idempotent gifting, rollback, chat visibility,
and ranking SQL. It removes its own container on exit. It never deletes a real
account. See `test/database-baseline/README.md` for the historical migration
replay limitation; this check is not a production restore rehearsal.

## Security and manual release review

Run `npm audit --omit=dev` in API and web to review currently published dependency
advisories. This sends public dependency metadata to npm. A successful build/test
gate does not imply an advisory-free dependency tree. Evaluate advisories and
dependency upgrades separately; do not use `npm audit fix --force` blindly.

Before resubmission, test on iPhone and iPad with the deployed API version:

- Sign in with the App Review account; reach Settings and reselect the current
  destination without duplicating navigation.
- Crop an onboarding profile photo; verify the final consent checkbox placement.
- Check Health permission denial and success, private-by-default wording, and
  unverified/verified eligibility copy.
- Make and restore an Apple sandbox purchase using a verified disposable account;
  recover from interrupted API activation without buying again.
- Check MARV consent and permitted content context, reporting, and blocking.
- Request deletion only for a disposable test account, confirm session revocation
  and scheduled cleanup, and verify the subscription-cancellation notice.

Deploy the API schema migration before testing a client that expects its new
columns. Passing local tests does not update the deployed database.
