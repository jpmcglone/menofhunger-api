/**
 * Backfill Post.cashtags for all posts whose cashtags array is empty or stale.
 *
 * Re-parses every post body, cross-references with the Ticker table, and
 * writes the validated cashtag array back.  Safe to re-run at any time.
 *
 * Usage: node scripts/backfill-cashtags.mjs [--dry-run]
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = resolve(__dirname, '../.env')
const envLines = readFileSync(envPath, 'utf8').split('\n')
for (const line of envLines) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '')
}

const { PrismaClient } = createRequire(import.meta.url)('@prisma/client')

// ── Cashtag regex (mirrors src/common/cashtags/cashtag-regex.ts) ──────────────
const CASHTAG_RE = /(?<![A-Za-z0-9_$])\$([A-Za-z]{1,6})(?![A-Za-z0-9_])/g

function parseCandidates(text) {
  if (!text) return []
  const seen = new Set()
  const out = []
  let m
  CASHTAG_RE.lastIndex = 0
  while ((m = CASHTAG_RE.exec(text)) !== null) {
    const sym = m[1].toUpperCase()
    if (!seen.has(sym)) { seen.add(sym); out.push(sym) }
  }
  return out
}

const prisma = new PrismaClient()

// ── Load valid symbols ────────────────────────────────────────────────────────
console.log('Loading ticker symbols from DB…')
const tickerRows = await prisma.ticker.findMany({ select: { symbol: true } })
const validSymbols = new Set(tickerRows.map(r => r.symbol))
console.log(`  ${validSymbols.size} valid symbols loaded`)

// ── Stream all posts in pages ─────────────────────────────────────────────────
const PAGE = 500
let cursor = undefined
let checked = 0
let updated = 0

console.log(`Scanning posts${DRY_RUN ? ' (DRY RUN — no writes)' : ''}…`)

while (true) {
  const posts = await prisma.post.findMany({
    take: PAGE,
    skip: cursor ? 1 : 0,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: { id: 'asc' },
    select: { id: true, body: true, cashtags: true },
  })

  if (posts.length === 0) break
  cursor = posts[posts.length - 1].id

  for (const post of posts) {
    checked++
    const candidates = parseCandidates(post.body ?? '')
    const newCashtags = candidates.filter(s => validSymbols.has(s))

    // Only write if the set changed
    const current = new Set(post.cashtags ?? [])
    const next = new Set(newCashtags)
    const changed =
      next.size !== current.size || [...next].some(s => !current.has(s))

    if (changed) {
      if (!DRY_RUN) {
        await prisma.post.update({
          where: { id: post.id },
          data: { cashtags: newCashtags },
        })
      }
      updated++
      if (DRY_RUN || updated <= 10) {
        console.log(`  [${DRY_RUN ? 'DRY' : 'UPDATE'}] post ${post.id}: ${JSON.stringify(post.cashtags)} → ${JSON.stringify(newCashtags)}`)
      }
    }
  }

  process.stdout.write(`\r  checked ${checked}, updated ${updated}…`)
}

console.log(`\nDone: checked ${checked} posts, updated ${updated}.`)
await prisma.$disconnect()
