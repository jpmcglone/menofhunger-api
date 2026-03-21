import type { Prisma } from '@prisma/client';

type CursorRow = {
  id: string;
  createdAt: Date;
  trendingScore: number | null;
};

/**
 * Pagination for group trending feed (same stored score column as global trending, score must be positive),
 * ordered by: trendingScore DESC, createdAt DESC, id DESC
 */
export async function groupTrendingCursorWhere(params: {
  cursor: string | null;
  lookup: (id: string) => Promise<CursorRow | null>;
}): Promise<Prisma.PostWhereInput | null> {
  const cursorId = (params.cursor ?? '').trim();
  if (!cursorId) return null;

  const row = await params.lookup(cursorId);
  if (!row || row.trendingScore == null) return null;

  const s = row.trendingScore;
  const createdAt = row.createdAt;
  const id = row.id;

  return {
    OR: [
      { trendingScore: { lt: s } },
      {
        AND: [{ trendingScore: s }, { createdAt: { lt: createdAt } }],
      },
      {
        AND: [{ trendingScore: s }, { createdAt }, { id: { lt: id } }],
      },
    ],
  };
}
