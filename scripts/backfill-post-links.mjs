/**
 * Backfill PostLink for existing posts (search matches link previews through it).
 *
 * Mirrors extractLinks (src/modules/link-metadata/link-metadata-extract.ts) and MAX_POST_LINKS
 * (src/modules/posts/post-links.ts) so urls match LinkMetadata keys. Batched by id and idempotent
 * (createMany skipDuplicates); safe to re-run. Refuses non-local databases unless --allow-remote.
 *
 * Usage: node scripts/backfill-post-links.mjs [--dry-run] [--allow-remote]
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')

for (const line of readFileSync(resolve(__dirname, '../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '')
}
const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
if (!['localhost', '127.0.0.1'].includes(host) && !process.argv.includes('--allow-remote')) {
  console.error(`Refusing to run against non-local database host "${host}" (pass --allow-remote to override).`)
  process.exit(1)
}

const { PrismaClient } = createRequire(import.meta.url)('@prisma/client')
const prisma = new PrismaClient()
const MAX_POST_LINKS = 20

function extractLinks(text) {
  const matches = (text ?? '').toString().match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []
  const out = []
  const seen = new Set()
  for (const m of matches) {
    try {
      const parsed = new URL(m.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      const norm = parsed.toString()
      if (seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    } catch { /* skip invalid URLs */ }
  }
  return out
}

const PAGE = 500
let cursor
let scanned = 0
let rows = 0
console.log(`Backfilling PostLink${DRY_RUN ? ' (DRY RUN)' : ''} on ${host}…`)
while (true) {
  const posts = await prisma.post.findMany({
    where: { body: { contains: 'http' } },
    select: { id: true, body: true },
    orderBy: { id: 'asc' },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
  if (posts.length === 0) break
  const data = posts.flatMap((p) => extractLinks(p.body).slice(0, MAX_POST_LINKS).map((url) => ({ postId: p.id, url })))
  if (data.length && !DRY_RUN) {
    const res = await prisma.postLink.createMany({ data, skipDuplicates: true })
    rows += res.count
  } else rows += data.length
  scanned += posts.length
  cursor = posts[posts.length - 1].id
}
console.log(`Scanned ${scanned} posts; ${DRY_RUN ? 'would insert' : 'inserted'} ${rows} PostLink rows.`)
await prisma.$disconnect()
