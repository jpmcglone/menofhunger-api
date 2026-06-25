#!/usr/bin/env node
// Self-healing wrapper around `prisma migrate deploy`.
//
// Background: `prisma migrate deploy` aborts with P3009 if the target database
// has a migration recorded in the failed state, and it will not apply ANY new
// migrations (even a corrected version of the failed one) until that record is
// cleared with `prisma migrate resolve`. On Render the pre-deploy step runs
// non-interactively, so there is no opportunity to run that one-off command.
//
// This wrapper clears the failed record for migrations on SAFE_ROLLBACK only.
// A migration belongs on that list when its failed attempt is guaranteed to
// have committed nothing — i.e. it runs entirely inside a single transaction
// (Prisma wraps each migration in a transaction) and/or a single atomic
// `DO $$ ... $$` block. Marking such a migration `--rolled-back` is correct:
// there is no partial state to clean up, and the corrected SQL will re-run on
// the same deploy.
//
// We attempt the rollback UNCONDITIONALLY (rather than parsing `migrate status`
// output, which is brittle across Prisma versions / CI environments). This is
// safe because `prisma migrate resolve --rolled-back` only succeeds on a
// migration that is actually in the failed state:
//   - failed     -> the record is cleared so the corrected SQL re-applies.
//   - applied    -> Prisma refuses ("cannot be rolled back ... not in a failed
//                   state") and changes nothing. We ignore the error.
//   - not present -> Prisma errors ("migration not found"). We ignore it; the
//                    subsequent `migrate deploy` applies it normally.
// Once the database is healthy this step is a harmless no-op, so it is safe to
// leave in place and idempotent across deploys.
import { execSync } from 'node:child_process'

// Migrations whose failed attempts are known to be atomic (committed nothing)
// and are therefore safe to auto-roll-back so the corrected SQL can re-apply.
const SAFE_ROLLBACK = ['20260625_accept_pending_marv_invites']

function capture(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return {
      ok: false,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    }
  }
}

function run(cmd) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
}

function healFailedMigrations() {
  for (const name of SAFE_ROLLBACK) {
    console.log(
      `[prisma-deploy] Ensuring migration "${name}" is not stuck in a failed state...`,
    )
    const resolved = capture(
      `npx prisma migrate resolve --rolled-back ${name}`,
    )
    const out = resolved.out.trim()
    if (out) console.log(out)
    if (resolved.ok) {
      console.log(
        `[prisma-deploy] Cleared a failed record for "${name}"; the corrected SQL will re-apply on deploy.`,
      )
    } else {
      console.log(
        `[prisma-deploy] No rollback needed for "${name}" (it is not in a failed state) — continuing.`,
      )
    }
  }
}

healFailedMigrations()
run('npx prisma migrate deploy')
