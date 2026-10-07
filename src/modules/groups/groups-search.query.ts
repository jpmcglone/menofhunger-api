import { Prisma } from '@prisma/client';
import { toCommunityGroupShellDto } from '../../common/dto/community-group.dto';
import type { GroupsService } from './groups.service';
import { queryToWords, scoreGroupAgainstQuery } from './groups.shared';

/**
 * Server-side fuzzy group search.
 *
 * The pipeline gathers candidates from up to three sources and unions them:
 *
 *   1. **Substring + per-word ILIKE** on `name`, `slug`, `description`,
 *      `rules`. Catches the common "I typed a few characters of the
 *      thing" case and is the only source guaranteed to run.
 *   2. **Trigram fuzzy** (`pg_trgm`) on `name` and `slug`. Catches typos
 *      ("stocism" → "stoicism") and partial-word matches that ILIKE
 *      would miss. Only runs when the query is ≥3 chars; trigram on
 *      shorter needles is mostly noise.
 *   3. **Full-text search** (`websearch_to_tsquery` over name + slug +
 *      description + rules). Catches multi-word natural-language queries
 *      with stemming ("running clubs" → "run club"). Only runs when the
 *      query has ≥2 words.
 *
 * Candidates are then **scored in memory** so the most relevant match
 * (exact name > prefix > contains > all-words-in-name > description, …)
 * always sits at the top, with `memberCount` as the tiebreaker. The
 * cursor is a numeric offset into the ranked list — same trade-off as
 * `searchPosts`: dead-simple to reason about and fine at the catalog
 * sizes we expect.
 *
 * Private (approval-policy) groups are only returned to viewers who are
 * already active members.
 */
export async function searchGroupsOn(host: GroupsService, params: {
  viewerUserId: string | null;
  q: string;
  limit: number;
  cursor: string | null;
  excludeMine?: boolean;
}): Promise<{
  data: ReturnType<typeof toCommunityGroupShellDto>[];
  pagination: { nextCursor: string | null };
}> {
  const q = (params.q ?? '').trim();
  if (q.length < 2) return { data: [], pagination: { nextCursor: null } };
  const lim = Math.min(30, Math.max(1, params.limit));
  const needle = q.slice(0, 200);
  const qLower = needle.toLowerCase();
  const words = queryToWords(needle);

  const cursorRaw = (params.cursor ?? '').trim();
  const offset =
    cursorRaw && /^\d+$/.test(cursorRaw) ? Math.max(0, parseInt(cursorRaw, 10)) : 0;

  // Private groups are only visible to active members. We model this as:
  //  joinPolicy = 'open'  OR  viewer is an active member
  const visibilityWhere: Prisma.CommunityGroupWhereInput = params.viewerUserId
    ? {
        OR: [
          { joinPolicy: 'open' },
          {
            members: {
              some: { userId: params.viewerUserId, status: 'active' },
            },
          },
        ],
      }
    : { joinPolicy: 'open' };

  const excludeMineWhere: Prisma.CommunityGroupWhereInput | undefined =
    params.excludeMine && params.viewerUserId
      ? {
          NOT: {
            members: {
              some: { userId: params.viewerUserId, status: 'active' },
            },
          },
        }
      : undefined;

  const baseAnd: Prisma.CommunityGroupWhereInput[] = [
    { deletedAt: null },
    visibilityWhere,
    ...(excludeMineWhere ? [excludeMineWhere] : []),
  ];

  // ─── Source 1: substring + per-word ILIKE ────────────────────────────
  // The OR set is built from a phrase clause for each searchable field
  // plus a per-word clause for every distinct token in the query. This
  // is what makes "running yoga" match a group whose name is "Yoga" and
  // whose description mentions "running buddies".
  const orConditions: Prisma.CommunityGroupWhereInput[] = [
    { name: { contains: needle, mode: 'insensitive' } },
    { slug: { contains: needle, mode: 'insensitive' } },
    { description: { contains: needle, mode: 'insensitive' } },
    { rules: { contains: needle, mode: 'insensitive' } },
  ];
  for (const w of words) {
    if (w === qLower) continue;
    orConditions.push({ name: { contains: w, mode: 'insensitive' } });
    orConditions.push({ slug: { contains: w, mode: 'insensitive' } });
    orConditions.push({ description: { contains: w, mode: 'insensitive' } });
    orConditions.push({ rules: { contains: w, mode: 'insensitive' } });
  }

  // Over-fetch generously so the in-memory ranking has a real candidate
  // pool to choose from. Bounded so a runaway query can't OOM the box.
  const fetchSize = Math.min(150, Math.max(lim * 6, 60));

  const primary = await host.prisma.communityGroup.findMany({
    where: { AND: [...baseAnd, { OR: orConditions }] },
    orderBy: [{ memberCount: 'desc' }, { id: 'desc' }],
    take: fetchSize,
  });

  // ─── Sources 2 + 3: trigram fuzzy + FTS ──────────────────────────────
  // Wrapped in try/catch so environments without `pg_trgm` /
  // `websearch_to_tsquery` (fresh test databases that haven't run the
  // search-index migration, for example) silently degrade to substring
  // results instead of erroring out.
  const useTrigram = needle.length >= 3;
  const useFts = needle.length >= 3 && words.length >= 2;
  let augmentIds: string[] = [];

  if (useTrigram || useFts) {
    const trigramSql = useTrigram
      ? Prisma.sql`(g."name" % ${needle} OR g."slug" % ${needle})`
      : Prisma.sql`FALSE`;
    const ftsSql = useFts
      ? Prisma.sql`to_tsvector(
          'english',
          COALESCE(g."name", '') || ' ' ||
          COALESCE(g."slug", '') || ' ' ||
          COALESCE(g."description", '') || ' ' ||
          COALESCE(g."rules", '')
        ) @@ websearch_to_tsquery('english', ${needle})`
      : Prisma.sql`FALSE`;

    try {
      const rows = await host.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT g."id" AS "id"
        FROM "CommunityGroup" g
        WHERE g."deletedAt" IS NULL
          AND (${trigramSql} OR ${ftsSql})
        LIMIT ${fetchSize}
      `);
      const primaryIds = new Set(primary.map((r) => r.id));
      augmentIds = rows.map((r) => r.id).filter((id) => !primaryIds.has(id));
    } catch {
      augmentIds = [];
    }
  }

  // Hydrate fuzzy/FTS candidates with the same visibility + excludeMine
  // gate as the primary path, so private groups the viewer can't see
  // never leak into the result set even if they matched on text.
  let augment: typeof primary = [];
  if (augmentIds.length > 0) {
    augment = await host.prisma.communityGroup.findMany({
      where: { AND: [...baseAnd, { id: { in: augmentIds } }] },
    });
  }

  const candidates = [...primary, ...augment];

  // ─── Viewer membership (used for owner-first sort + DTO annotation) ──
  // Fetched here, before ranking, so groups the viewer owns can be
  // bumped to the top of the list — even when their text relevance is
  // weaker than another group's. This matters across pagination too:
  // sorting client-side per page would scatter owned groups across pages
  // depending on which slice they happened to land in.
  type ViewerMembershipRow = Prisma.CommunityGroupMemberGetPayload<{
    select: { groupId: true; status: true; role: true };
  }>;
  let allMemberships: ViewerMembershipRow[] = [];
  if (params.viewerUserId && candidates.length > 0) {
    allMemberships = await host.prisma.communityGroupMember.findMany({
      where: { userId: params.viewerUserId, groupId: { in: candidates.map((c) => c.id) } },
      select: { groupId: true, status: true, role: true },
    });
  }
  const ownedIds = new Set(
    allMemberships
      .filter((m) => m.role === 'owner' && m.status === 'active')
      .map((m) => m.groupId),
  );
  const membershipByGroup = new Map(allMemberships.map((m) => [m.groupId, m] as const));

  // ─── Score & rank ────────────────────────────────────────────────────
  const ranked = candidates
    .map((g) => ({ g, score: scoreGroupAgainstQuery(g, qLower, words) }))
    .sort((a, b) => {
      const aOwned = ownedIds.has(a.g.id);
      const bOwned = ownedIds.has(b.g.id);
      if (aOwned !== bOwned) return aOwned ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      const am = a.g.memberCount ?? 0;
      const bm = b.g.memberCount ?? 0;
      if (bm !== am) return bm - am;
      return b.g.id.localeCompare(a.g.id);
    });

  const slice = ranked.slice(offset, offset + lim).map((r) => r.g);
  const nextCursor = offset + lim < ranked.length ? String(offset + lim) : null;

  if (!params.viewerUserId) {
    return {
      data: slice.map((g) => toCommunityGroupShellDto(g, null)),
      pagination: { nextCursor },
    };
  }
  return {
    data: slice.map((g) => {
      const m = membershipByGroup.get(g.id);
      const viewerMembership = m ? { status: m.status, role: m.role } : null;
      return toCommunityGroupShellDto(g, viewerMembership);
    }),
    pagination: { nextCursor },
  };
}
