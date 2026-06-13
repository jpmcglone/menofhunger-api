/**
 * One-shot SEC ticker seed script.
 * Usage: node scripts/seed-tickers.mjs
 * Reads DATABASE_URL from .env in the repo root.
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Load .env manually ───────────────────────────────────────────────────────
const envPath = resolve(__dirname, '../.env')
const envLines = readFileSync(envPath, 'utf8').split('\n')
for (const line of envLines) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '')
}

const { PrismaClient } = createRequire(import.meta.url)('@prisma/client')

const SEC_URL = 'https://www.sec.gov/files/company_tickers.json'
const USER_AGENT = 'menofhunger-dev/1.0 support@menofhunger.com'
const BATCH = 500

function chunks(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const prisma = new PrismaClient()

console.log(`Fetching tickers from ${SEC_URL} …`)
const res = await fetch(SEC_URL, {
  headers: { 'User-Agent': USER_AGENT },
  signal: AbortSignal.timeout(30_000),
})
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

const json = await res.json()
const entries = Object.values(json)
console.log(`Got ${entries.length} entries from SEC`)

let upserted = 0
let skipped = 0

for (const batch of chunks(entries, BATCH)) {
  await Promise.all(
    batch.map(async (e) => {
      const symbol = (e.ticker ?? '').trim().toUpperCase()
      const name = (e.title ?? '').trim()
      if (!symbol || !name) { skipped++; return }
      await prisma.ticker.upsert({
        where: { symbol },
        create: { symbol, name, source: 'sec' },
        update: { name, source: 'sec' },
      })
      upserted++
    }),
  )
  process.stdout.write(`\r  ${upserted} upserted, ${skipped} skipped…`)
}

console.log(`\nDone: ${upserted} tickers seeded, ${skipped} skipped.`)
await prisma.$disconnect()
