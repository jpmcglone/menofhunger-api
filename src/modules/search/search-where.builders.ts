import { Prisma } from '@prisma/client';
import { NOT_DELETED } from '../../common/prisma/where';

/** Broad match: body or author username/name (phrase + each word) so "john steve" matches @john, @steve, or body. */
export function postSearchMatchWhere(q: string, words: string[], noteKeys: string[] = []): object {
  const trimmed = (q ?? '').trim();
  if (!trimmed) return {};
  const orConditions: any[] = [
    { body: { contains: trimmed, mode: 'insensitive' as const } },
    { user: { username: { contains: trimmed, mode: 'insensitive' as const } } },
    { user: { name: { contains: trimmed, mode: 'insensitive' as const } } },
  ];
  // Photos Marv described: match through the files whose note fits the query.
  if (noteKeys.length > 0) {
    orConditions.push({
      media: { some: { ...NOT_DELETED, OR: [{ r2Key: { in: noteKeys } }, { thumbnailR2Key: { in: noteKeys } }] } },
    });
  }
  for (const w of words) {
    if (w === trimmed.toLowerCase()) continue;
    orConditions.push({ body: { contains: w, mode: 'insensitive' as const } });
    orConditions.push({ user: { username: { contains: w, mode: 'insensitive' as const } } });
    orConditions.push({ user: { name: { contains: w, mode: 'insensitive' as const } } });
  }
  return { OR: orConditions };
}

export function visibleBookmarkedPostWhere(userId: string): Prisma.PostWhereInput {
  return {
    OR: [
      { communityGroupId: null },
      {
        communityGroup: {
          members: {
            some: {
              userId,
              status: 'active',
            },
          },
        },
      },
    ],
  };
}

export function articleSearchMatchWhere(q: string, words: string[]): object {
  const trimmed = (q ?? '').trim();
  if (!trimmed) return {};
  const orConditions: any[] = [
    { title: { contains: trimmed, mode: 'insensitive' as const } },
    { excerpt: { contains: trimmed, mode: 'insensitive' as const } },
    { author: { username: { contains: trimmed, mode: 'insensitive' as const } } },
    { author: { name: { contains: trimmed, mode: 'insensitive' as const } } },
  ];
  for (const w of words) {
    if (w === trimmed.toLowerCase()) continue;
    orConditions.push({ title: { contains: w, mode: 'insensitive' as const } });
    orConditions.push({ excerpt: { contains: w, mode: 'insensitive' as const } });
    orConditions.push({ author: { username: { contains: w, mode: 'insensitive' as const } } });
    orConditions.push({ author: { name: { contains: w, mode: 'insensitive' as const } } });
  }
  return { OR: orConditions };
}
