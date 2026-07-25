/**
 * Backfill poll_results_ready notification titles with tiered vote-count copy.
 *
 * Finds every poll_results_ready notification, looks up the current vote count
 * on the associated poll, and rewrites the title using the same tiered logic
 * as the live cron job.  Safe to re-run — idempotent by design.
 *
 * Usage:
 *   node scripts/backfill-poll-notification-titles.mjs [--dry-run]
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = resolve(__dirname, '../.env')
const envLines = readFileSync(envPath, 'utf8').split('\n')
for (const line of envLines) {
  const [k, ...rest] = line.split('=')
  if (k && rest.length) process.env[k.trim()] = rest.join('=').trim()
}

// ── Prisma ───────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

// ── Tiered title logic (mirrors posts-poll-results-ready.cron.ts) ────────────
function voteLabel(n) {
  if (n === 0) return 'No votes'
  if (n === 1) return '1 vote'
  return `${n} votes`
}

function authorTitle(totalVotes) {
  const label = voteLabel(totalVotes)
  if (totalVotes === 0) return `Your poll was a dud · No votes`
  if (totalVotes < 10) return `Your poll got a few votes · ${label}`
  if (totalVotes < 40) return `Your poll got real traction · ${label}`
  return `Your poll was a hit · ${label}`
}

function voterTitle(totalVotes) {
  const label = voteLabel(totalVotes)
  if (totalVotes < 40) return `Poll results are in · ${label}`
  return `Great poll — results are in · ${label}`
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[backfill-poll-notification-titles] dry-run=${DRY_RUN}`)

  // Load all poll_results_ready notifications that have a subjectPostId.
  const notifications = await prisma.notification.findMany({
    where: { kind: 'poll_results_ready', subjectPostId: { not: null } },
    select: { id: true, recipientUserId: true, subjectPostId: true, actorUserId: true, title: true },
  })

  console.log(`Found ${notifications.length} poll_results_ready notifications`)

  // Group by subjectPostId to batch the poll lookups.
  const postIds = [...new Set(notifications.map((n) => n.subjectPostId).filter(Boolean))]

  // For each post, look up the poll and vote count.
  const pollByPostId = new Map()
  for (const postId of postIds) {
    const poll = await prisma.postPoll.findFirst({
      where: { postId },
      select: { id: true, post: { select: { userId: true } }, _count: { select: { votes: true } } },
    })
    if (poll) pollByPostId.set(postId, poll)
  }

  let updated = 0
  let skipped = 0

  for (const n of notifications) {
    const poll = pollByPostId.get(n.subjectPostId)
    if (!poll) {
      console.log(`  skip id=${n.id} — no poll found for post ${n.subjectPostId}`)
      skipped++
      continue
    }

    const totalVotes = poll._count.votes
    const authorId = poll.post.userId
    // actorUserId is null for the author (self-skip guard in notifications.create)
    const isAuthor = n.actorUserId == null && n.recipientUserId === authorId
    const newTitle = isAuthor ? authorTitle(totalVotes) : voterTitle(totalVotes)

    if (n.title === newTitle) {
      skipped++
      continue
    }

    console.log(`  update id=${n.id} author=${isAuthor} votes=${totalVotes}`)
    console.log(`    old: ${n.title}`)
    console.log(`    new: ${newTitle}`)

    if (!DRY_RUN) {
      await prisma.notification.update({ where: { id: n.id }, data: { title: newTitle } })
    }
    updated++
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped}${DRY_RUN ? ' (dry-run, no writes)' : ''}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
