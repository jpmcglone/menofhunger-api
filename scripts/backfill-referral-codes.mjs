/**
 * Give every verified member without a referral code one derived from their username
 * (same rule as ReferralService.ensureCode). Existing codes are never touched.
 *
 * Usage: node scripts/backfill-referral-codes.mjs            (dry run, prints the plan)
 *        node scripts/backfill-referral-codes.mjs --apply    (writes codes)
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')

for (const line of readFileSync(resolve(__dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '')
}

const { PrismaClient } = createRequire(import.meta.url)('@prisma/client')
const prisma = new PrismaClient()

function candidates(username) {
  const base = (username ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '')
  if (base.length < 3) return []
  return Array.from({ length: 10 }, (_, i) => {
    const suffix = i === 0 ? '' : String(i + 1)
    return `${base.slice(0, 20 - suffix.length)}${suffix}`
  })
}

const members = await prisma.user.findMany({
  where: { referralCode: null, verifiedStatus: { not: 'none' }, bannedAt: null, isBot: false, username: { not: null } },
  select: { id: true, username: true },
  orderBy: { createdAt: 'asc' },
})

let assigned = 0
let skipped = 0
for (const member of members) {
  let done = false
  for (const code of candidates(member.username)) {
    if (!APPLY) {
      const taken = await prisma.user.findFirst({ where: { referralCode: code }, select: { id: true } })
      if (taken) continue
      console.log(`[dry-run] @${member.username} -> ${code}`)
      done = true
      break
    }
    try {
      const { count } = await prisma.user.updateMany({ where: { id: member.id, referralCode: null }, data: { referralCode: code } })
      console.log(`@${member.username} -> ${count ? code : '(already has a code)'}`)
      done = true
      break
    } catch (err) {
      if (err?.code !== 'P2002') throw err
    }
  }
  if (done) assigned++
  else {
    skipped++
    console.warn(`Could not derive a code for @${member.username} (${member.id})`)
  }
}

console.log(`${APPLY ? 'Assigned' : 'Would assign'} ${assigned} code(s); ${skipped} skipped; ${members.length} verified member(s) without a code.`)
await prisma.$disconnect()
