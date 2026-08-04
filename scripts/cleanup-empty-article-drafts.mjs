/**
 * Delete article drafts that were never given any content.
 *
 * Until the editor moved to lazy draft creation, visiting /articles/new POSTed a row
 * before the author typed anything, so a mis-tap on "Write" left an "Untitled" draft
 * behind. This removes those rows. The emptiness test mirrors `hasContent` in
 * menofhunger-www/composables/useArticleEditor.ts: a draft is empty only when it has
 * no title, no body text, no thumbnail, and no tags.
 *
 * Deletion is hard, not soft: a row that never held content has nothing worth
 * tombstoning, and purging it frees its `draft-N` slug. Every candidate is re-checked
 * for engagement rows (boosts, reactions, comments, views, share posts, notifications)
 * and skipped if any exist, so a draft that somehow accumulated activity survives.
 *
 * Dry-run by default. Nothing is written without --apply.
 *
 * Usage:
 *   node scripts/cleanup-empty-article-drafts.mjs            # report only
 *   node scripts/cleanup-empty-article-drafts.mjs --apply    # delete
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')

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

// ── Emptiness test (mirrors useArticleEditor.isBodyEmpty) ────────────────────
function hasText(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'text') return !!(node.text && node.text.trim())
  if (Array.isArray(node.content)) return node.content.some(hasText)
  return false
}

function isBodyEmpty(raw) {
  if (!raw) return true
  try {
    return !hasText(JSON.parse(raw))
  } catch {
    return !raw.trim()
  }
}

/** Relations that make a draft worth keeping regardless of its content. */
const ENGAGEMENT = ['boosts', 'reactions', 'comments', 'views', 'anonViews', 'sharePosts', 'notifications']

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[cleanup-empty-article-drafts] ${APPLY ? 'APPLY — rows will be deleted' : 'dry run — no writes'}`)

  // Filtered in JS rather than SQL so whitespace-only titles and empty-string
  // thumbnail keys are caught too. Draft volume is small enough for a full scan.
  const drafts = await prisma.article.findMany({
    where: { isDraft: true, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      body: true,
      thumbnailR2Key: true,
      createdAt: true,
      author: { select: { username: true } },
      _count: {
        select: {
          tags: true,
          boosts: true,
          reactions: true,
          comments: true,
          views: true,
          anonViews: true,
          sharePosts: true,
          notifications: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`Scanned ${drafts.length} drafts`)

  const doomed = []
  let keptForContent = 0
  let keptForEngagement = 0

  for (const d of drafts) {
    const hasContent = !!d.title.trim() || !isBodyEmpty(d.body) || !!d.thumbnailR2Key || d._count.tags > 0
    if (hasContent) {
      keptForContent++
      continue
    }
    const engaged = ENGAGEMENT.filter((rel) => d._count[rel] > 0)
    if (engaged.length) {
      console.log(`  keep id=${d.id} — empty but has ${engaged.join(', ')}`)
      keptForEngagement++
      continue
    }
    doomed.push(d)
  }

  for (const d of doomed) {
    console.log(`  delete id=${d.id} slug=${d.slug} author=${d.author?.username ?? '?'} created=${d.createdAt.toISOString()}`)
  }

  if (APPLY && doomed.length) {
    const { count } = await prisma.article.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } })
    console.log(`\nDeleted ${count} rows.`)
  }

  console.log(
    `\nDone. empty=${doomed.length} keptForContent=${keptForContent} keptForEngagement=${keptForEngagement}`
    + `${APPLY ? '' : ' (dry run — re-run with --apply to delete)'}`,
  )
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
