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
// the same deploy. Once the database is healthy the resolve call becomes a
// harmless no-op (the migration is `applied`, not `failed`), so this is safe to
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

function getMigrationStatus() {
  // `prisma migrate status` exits non-zero when there are failed/pending
  // migrations, so read stdout from both the ok and error paths.
  return capture('npx prisma migrate status').out
}

function healFailedMigrations() {
  const status = getMigrationStatus()
  for (const name of SAFE_ROLLBACK) {
    const failed =
      status.includes(name) && /failed/i.test(status)
    if (!failed) continue
    console.log(
      `[prisma-deploy] Detected failed migration "${name}" on the safe-rollback list; marking it rolled-back so the corrected SQL can re-apply.`,
    )
    const resolved = capture(
      `npx prisma migrate resolve --rolled-back ${name}`,
    )
    if (resolved.ok) {
      console.log(`[prisma-deploy] Rolled back "${name}".`)
    } else {
      // Non-fatal: if it was already cleared/applied, deploy will surface any
      // real problem next.
      console.warn(
        `[prisma-deploy] resolve --rolled-back for "${name}" did not succeed (it may already be cleared):\n${resolved.out}`,
      )
    }
  }
}

healFailedMigrations()
run('npx prisma migrate deploy')
