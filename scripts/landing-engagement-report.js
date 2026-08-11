#!/usr/bin/env node
/**
 * One-shot engagement/concentration report for landing-stat transparency.
 *
 * Filters match LandingService.computeSnapshot men/posts CTEs:
 *   men  = verified, username set, not banned, not org
 *   posts = kind=regular, not draft/deleted, visibility public|verifiedOnly|premiumOnly,
 *           author passes the same men filters
 *
 * Usage:
 *   node scripts/landing-engagement-report.js
 *   DATABASE_URL='postgres://…' node scripts/landing-engagement-report.js
 */
/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function pct(n, d) {
  if (!d) return '0%';
  return `${((100 * n) / d).toFixed(1)}%`;
}

function num(v) {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

async function main() {
  const [summary] = await prisma.$queryRaw`
    WITH men AS (
      SELECT u.id
      FROM "User" u
      WHERE u."bannedAt" IS NULL
        AND u."usernameIsSet" = true
        AND u."isOrganization" = false
        AND u."verifiedStatus" != 'none'
    ),
    eligible_posts AS (
      SELECT p.id, p."userId", p."parentId", p."viewerCount", p."createdAt"
      FROM "Post" p
      JOIN men m ON m.id = p."userId"
      WHERE p."deletedAt" IS NULL
        AND p."isDraft" = false
        AND p."kind" = 'regular'
        AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
    ),
    author_totals AS (
      SELECT
        ep."userId",
        COUNT(*)::int AS posts,
        COUNT(*) FILTER (WHERE ep."parentId" IS NULL)::int AS roots,
        COUNT(*) FILTER (WHERE ep."parentId" IS NOT NULL)::int AS replies
      FROM eligible_posts ep
      GROUP BY ep."userId"
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY posts DESC, "userId") AS rn
      FROM author_totals
    ),
    viewers_30d AS (
      SELECT DISTINCT pv."userId" AS id
      FROM "PostView" pv
      JOIN eligible_posts ep ON ep.id = pv."postId"
      JOIN men m ON m.id = pv."userId"
      WHERE pv."lastSeenAt" >= NOW() - INTERVAL '30 days'
    )
    SELECT
      (SELECT COUNT(*)::int FROM men) AS verified_men,
      (SELECT COUNT(*)::int FROM author_totals) AS ever_contributed,
      (SELECT COUNT(*)::int FROM author_totals at
        WHERE EXISTS (
          SELECT 1 FROM eligible_posts ep
          WHERE ep."userId" = at."userId"
            AND ep."createdAt" >= NOW() - INTERVAL '30 days'
        )
      ) AS contributed_30d,
      (SELECT COUNT(*)::int FROM viewers_30d) AS viewed_30d,
      (SELECT COUNT(*)::int FROM eligible_posts) AS posts_total,
      (SELECT COUNT(*)::int FROM eligible_posts WHERE "parentId" IS NULL) AS roots_total,
      (SELECT COUNT(*)::int FROM eligible_posts WHERE "parentId" IS NOT NULL) AS replies_total,
      (SELECT COALESCE(SUM("viewerCount"), 0)::bigint FROM eligible_posts) AS views_total,
      (SELECT COALESCE(MAX(posts), 0)::int FROM ranked) AS top_author_posts,
      (SELECT COALESCE(SUM(posts), 0)::int FROM ranked WHERE rn <= 5) AS top5_posts
  `;

  const topAuthors = await prisma.$queryRaw`
    WITH men AS (
      SELECT u.id
      FROM "User" u
      WHERE u."bannedAt" IS NULL
        AND u."usernameIsSet" = true
        AND u."isOrganization" = false
        AND u."verifiedStatus" != 'none'
    ),
    eligible_posts AS (
      SELECT p.id, p."userId", p."parentId"
      FROM "Post" p
      JOIN men m ON m.id = p."userId"
      WHERE p."deletedAt" IS NULL
        AND p."isDraft" = false
        AND p."kind" = 'regular'
        AND p."visibility" IN ('public', 'verifiedOnly', 'premiumOnly')
    )
    SELECT
      u.username,
      u."isBot",
      COUNT(*)::int AS posts,
      COUNT(*) FILTER (WHERE ep."parentId" IS NULL)::int AS roots,
      COUNT(*) FILTER (WHERE ep."parentId" IS NOT NULL)::int AS replies
    FROM eligible_posts ep
    JOIN "User" u ON u.id = ep."userId"
    GROUP BY u.id, u.username, u."isBot"
    ORDER BY posts DESC
    LIMIT 10
  `;

  const verifiedMen = num(summary.verified_men);
  const ever = num(summary.ever_contributed);
  const c30 = num(summary.contributed_30d);
  const v30 = num(summary.viewed_30d);
  const posts = num(summary.posts_total);
  const roots = num(summary.roots_total);
  const replies = num(summary.replies_total);
  const views = num(summary.views_total);
  const top1 = num(summary.top_author_posts);
  const top5 = num(summary.top5_posts);

  console.log('Landing engagement / concentration (landing-stat filters)\n');
  console.log(`Verified men:                 ${verifiedMen}`);
  console.log(`Ever contributed:             ${ever} (${pct(ever, verifiedMen)})`);
  console.log(`Contributed in last 30 days:  ${c30} (${pct(c30, verifiedMen)})`);
  console.log(`Viewed something in last 30d: ${v30} (${pct(v30, verifiedMen)})`);
  console.log('');
  console.log(`Eligible content:             ${posts}  (${roots} original / ${replies} replies)`);
  console.log(`Unique views (person×post):   ${views.toLocaleString('en-US')}`);
  console.log('');
  console.log(`Top author share:             ${pct(top1, posts)}  (${top1} of ${posts})`);
  console.log(`Top 5 author share:           ${pct(top5, posts)}  (${top5} of ${posts})`);
  console.log(`Contributors / verified men:  ${ever} / ${verifiedMen} = ${pct(ever, verifiedMen)}`);
  console.log('');
  console.log('Top authors:');
  for (const row of topAuthors) {
    const bot = row.isBot ? ' [bot]' : '';
    console.log(
      `  @${row.username}${bot}: ${row.posts} total (${row.roots} original, ${row.replies} replies) — ${pct(num(row.posts), posts)}`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
