import { Prisma } from '@prisma/client';

/**
 * Walk Post.parentId chains in one round trip. Shared by feed compose and
 * notification PostDto hydration so neither path reintroduces an N-depth loop.
 *
 * Deleted rows are included: feed/notification callers apply their own
 * visibility + deleted filters on the subsequent findMany.
 */
export async function collectAncestorPostIds(
  prisma: { $queryRaw: (query: Prisma.Sql) => Promise<unknown> },
  seedIds: Array<string | null | undefined>,
): Promise<string[]> {
  const seeds = [...new Set((seedIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))];
  if (seeds.length === 0) return [];

  const rows = (await prisma.$queryRaw(Prisma.sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, "parentId" FROM "Post" WHERE id IN (${Prisma.join(seeds)})
      UNION
      SELECT p.id, p."parentId" FROM "Post" p
      INNER JOIN ancestors a ON a."parentId" = p.id
    )
    SELECT DISTINCT id FROM ancestors
  `)) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
