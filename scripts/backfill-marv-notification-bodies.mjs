/**
 * Backfill marv_not_in_group notification bodies to include the real group name.
 *
 * Finds every marv_not_in_group notification whose body still says "this group",
 * looks up the group name from subjectGroupId, and rewrites the body.
 * Safe to re-run — rows that already have the correct body are skipped.
 *
 * Usage:
 *   node scripts/backfill-marv-notification-bodies.mjs [--dry-run]
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')

// ── Load .env (local only — Render injects env vars directly) ────────────────
const envPath = resolve(__dirname, '../.env')
try {
  const envLines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of envLines) {
    const [k, ...rest] = line.split('=')
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim()
  }
} catch {
  // no .env file — rely on process.env (production / CI)
}

// ── Prisma ───────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[backfill-marv-notification-bodies] dry-run=${DRY_RUN}`)

  const notifications = await prisma.notification.findMany({
    where: { kind: 'marv_not_in_group', subjectGroupId: { not: null } },
    select: { id: true, subjectGroupId: true, body: true },
  })

  console.log(`Found ${notifications.length} marv_not_in_group notifications`)

  // Batch-load group names
  const groupIds = [...new Set(notifications.map((n) => n.subjectGroupId).filter(Boolean))]
  const groups = await prisma.communityGroup.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, name: true },
  })
  const groupNameById = new Map(groups.map((g) => [g.id, g.name?.trim() || null]))

  let updated = 0
  let skipped = 0

  for (const n of notifications) {
    const groupName = groupNameById.get(n.subjectGroupId) ?? null
    const groupLabel = groupName ? `**${groupName}**` : 'this group'
    const newBody = `@marv is not in ${groupLabel}, so he won't respond. Ask an owner to add him!`

    if (n.body === newBody) {
      skipped++
      continue
    }

    console.log(`  update id=${n.id} group="${groupName}"`)
    console.log(`    old: ${n.body}`)
    console.log(`    new: ${newBody}`)

    if (!DRY_RUN) {
      await prisma.notification.update({ where: { id: n.id }, data: { body: newBody } })
    }
    updated++
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped}${DRY_RUN ? ' (dry-run, no writes)' : ''}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
