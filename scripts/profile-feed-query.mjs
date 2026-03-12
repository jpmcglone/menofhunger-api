import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function printPlan(label, rows) {
  console.log(`--- ${label} ---`);
  for (const row of rows ?? []) {
    const line = row?.['QUERY PLAN'] ?? row?.['QUERY_PLAN'] ?? Object.values(row ?? {})?.[0];
    if (line) console.log(String(line));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx] ?? 0;
}

async function main() {
  const explainNew = await prisma.$queryRawUnsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT p.id, p."createdAt"
    FROM "Post" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p."deletedAt" IS NULL
      AND p."parentId" IS NULL
      AND p.visibility IN ('public', 'verifiedOnly', 'premiumOnly')
      AND u."bannedAt" IS NULL
    ORDER BY p."createdAt" DESC, p.id DESC
    LIMIT 31
  `);

  const explainTrending = await prisma.$queryRawUnsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT p.id, p."trendingScore", p."createdAt"
    FROM "Post" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p."deletedAt" IS NULL
      AND p."parentId" IS NULL
      AND p."kind"::text <> 'repost'
      AND p.visibility IN ('public', 'verifiedOnly', 'premiumOnly')
      AND u."bannedAt" IS NULL
    ORDER BY p."trendingScore" DESC, p."createdAt" DESC, p.id DESC
    LIMIT 31
  `);

  const runsMs = [];
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    await prisma.post.findMany({
      where: {
        deletedAt: null,
        parentId: null,
        visibility: { in: ['public', 'verifiedOnly', 'premiumOnly'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
      select: { id: true, createdAt: true, userId: true },
    });
    runsMs.push(Math.round(performance.now() - start));
  }
  runsMs.sort((a, b) => a - b);

  printPlan('EXPLAIN NEW FEED', explainNew);
  printPlan('EXPLAIN TRENDING FEED', explainTrending);
  console.log('--- FINDMANY BENCHMARK ---');
  console.log(JSON.stringify({
    sampleSize: runsMs.length,
    p50Ms: percentile(runsMs, 0.5),
    p95Ms: percentile(runsMs, 0.95),
    maxMs: runsMs[runsMs.length - 1] ?? 0,
    allRunsMs: runsMs,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

