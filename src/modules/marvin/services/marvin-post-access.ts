import type { Prisma } from '@prisma/client';

/**
 * Posts Marv may use as public profile evidence (context cards).
 *
 * Group posts are members-only even when `visibility` is `public` — that flag is
 * the audience *inside* the group. Private (approval) groups especially must never
 * train a card that Marv can later read in a DM or public thread.
 */
export function marvPublicProfilePostWhere(): Prisma.PostWhereInput {
  return { communityGroupId: null };
}

/**
 * Extra OR clauses for Marv tools (`get_post`, thread recent/summary).
 *
 * Allows: non-group posts, open-group posts, and — only when Marv is already
 * in that conversation — posts in the current thread (so a @marv mention inside
 * a private group still works). Blocks fetching a private-group post from a DM
 * or a different thread.
 */
export function marvToolGroupAccessOr(rootPostId?: string | null): Prisma.PostWhereInput[] {
  const root = (rootPostId ?? '').trim();
  const or: Prisma.PostWhereInput[] = [
    { communityGroupId: null },
    { communityGroup: { deletedAt: null, joinPolicy: 'open' } },
  ];
  if (root) {
    or.push({ id: root }, { rootId: root });
  }
  return or;
}
