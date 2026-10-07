import { Prisma } from '@prisma/client';
import { toCommunityGroupShellDto } from '../../common/dto/community-group.dto';
import type { GroupsService } from './groups.service';
import { decodeGroupCursor, encodeGroupCursor } from './groups.shared';

/**
 * Explore discovery: a richly-stacked spotlight that should never come back
 * empty when the system has groups the viewer can plausibly join.
 *
 * **Page 1 (no cursor)** is a tiered waterfall:
 *   1. Featured (admin-curated, ordered by featuredOrder)
 *   2. Trending — most posts in the last 14 days (community heat signal)
 *   3. Popular — top by memberCount (steady-state size signal)
 *   4. Recent — newest groups (long-tail discovery, prevents emptiness)
 *
 * **Page 2+ (with cursor)** drops the curated overlays and degrades to a
 * simple `(memberCount desc, id desc)` keyset scan. Once the user has
 * already seen the spotlight, "more" is just a sorted catalog — we don't
 * re-curate on every fetch.
 *
 * `excludeMine` filters out groups the viewer is already an active member
 * of. The cap (`take`, default 24) is the upper bound after dedup; the
 * actual count is whatever's available — never artificially padded.
 * `nextCursor` is set whenever we hit `take` rows; the client paginates
 * until it's null.
 */
export async function listExploreSpotlightOn(host: GroupsService, 
  viewerUserId: string | null,
  opts: { excludeMine?: boolean; take?: number; cursor?: string | null } = {},
) {
  const take = Math.min(Math.max(opts.take ?? 24, 1), 60);
  const excludeMine = Boolean(opts.excludeMine && viewerUserId);
  const decodedCursor = decodeGroupCursor(opts.cursor ?? null);

  // Pre-compute the viewer's active group IDs once so each tier / cursor
  // page can exclude them server-side. Empty when not authed or excludeMine
  // is false.
  let mineIds: string[] = [];
  if (excludeMine && viewerUserId) {
    const mine = await host.prisma.communityGroupMember.findMany({
      where: { userId: viewerUserId, status: 'active' },
      select: { groupId: true },
    });
    mineIds = mine.map((m) => m.groupId);
  }
  const baseExclude: Prisma.CommunityGroupWhereInput = { deletedAt: null };

  // Helper: build a where clause that excludes BOTH the viewer's groups
  // and any IDs already chosen in earlier tiers. We merge into a single
  // `notIn` list because Prisma's plain `where` is an AND of properties,
  // and using `{ ...baseExclude, id: {...} }` would *overwrite* an
  // existing `id` filter rather than intersect with it — which previously
  // caused `mineIds` to be silently dropped from Tier 3/4 the moment any
  // featured/trending row landed in `seenIds`. Using one combined `notIn`
  // makes the intent explicit and impossible to clobber.
  const buildExcludeWhere = (
    extra: ReadonlySet<string>,
  ): Prisma.CommunityGroupWhereInput => {
    const exclude = new Set<string>(mineIds);
    for (const id of extra) exclude.add(id);
    return exclude.size > 0
      ? { ...baseExclude, id: { notIn: [...exclude] } }
      : { ...baseExclude };
  };

  // ─── Subsequent pages: simple memberCount-desc keyset ────────────────
  // The waterfall is intentionally a one-shot first-page treatment. Once
  // the user is paginating, give them a homogeneous catalog ordered by
  // popularity so the cursor is meaningful.
  if (decodedCursor) {
    const cursorWhere: Prisma.CommunityGroupWhereInput = {
      OR: [
        { memberCount: { lt: decodedCursor.memberCount } },
        { memberCount: decodedCursor.memberCount, id: { lt: decodedCursor.id } },
      ],
    };
    const rows = await host.prisma.communityGroup.findMany({
      where: { AND: [buildExcludeWhere(new Set()), cursorWhere] },
      orderBy: [{ memberCount: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    const last = slice[slice.length - 1];
    const nextCursor = hasMore && last
      ? encodeGroupCursor({ memberCount: last.memberCount, id: last.id })
      : null;
    return {
      data: await attachExploreMembership(host, slice, viewerUserId),
      pagination: { nextCursor },
    };
  }

  // ─── First page: tiered waterfall ────────────────────────────────────
  // Tier 1: Featured (curated)
  const featured = await host.prisma.communityGroup.findMany({
    where: { ...buildExcludeWhere(new Set()), isFeatured: true },
    orderBy: [{ featuredOrder: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(take, 8),
  });
  const seenIds = new Set(featured.map((g) => g.id));

  // Tier 2: Trending — most posts in the last 14d. Single GROUP BY query.
  let trending: Array<typeof featured[number]> = [];
  if (seenIds.size < take) {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const heat = await host.postsRead.read.groupBy({
      by: ['communityGroupId'],
      where: {
        deletedAt: null,
        createdAt: { gte: since },
        communityGroupId: { not: null, ...(mineIds.length ? { notIn: mineIds } : {}) },
      },
      _count: { _all: true },
      orderBy: { _count: { communityGroupId: 'desc' } },
      take: Math.max(take, 24),
    });
    const heatIds = heat
      .map((h) => h.communityGroupId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && !seenIds.has(id));
    if (heatIds.length) {
      // AND-merge so the `in: heatIds` filter doesn't clobber the
      // `notIn: mineIds` baseline (heatIds is already pre-filtered above,
      // but we keep the gate explicit so this stays correct under refactor).
      const rows = await host.prisma.communityGroup.findMany({
        where: { AND: [buildExcludeWhere(new Set()), { id: { in: heatIds } }] },
      });
      // Re-order by heat (Prisma findMany doesn't preserve `in` order)
      const order = new Map(heatIds.map((id, i) => [id, i] as const));
      trending = rows
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .slice(0, take - seenIds.size);
      for (const g of trending) seenIds.add(g.id);
    }
  }

  // Tier 3: Popular by memberCount
  let popular: Array<typeof featured[number]> = [];
  if (seenIds.size < take) {
    popular = await host.prisma.communityGroup.findMany({
      where: buildExcludeWhere(seenIds),
      orderBy: [{ memberCount: 'desc' }, { createdAt: 'desc' }],
      take: take - seenIds.size,
    });
    for (const g of popular) seenIds.add(g.id);
  }

  // Tier 4: Recent (long tail; ensures we never come back empty if anything exists)
  let recent: Array<typeof featured[number]> = [];
  if (seenIds.size < take) {
    recent = await host.prisma.communityGroup.findMany({
      where: buildExcludeWhere(seenIds),
      orderBy: [{ createdAt: 'desc' }],
      take: take - seenIds.size,
    });
  }

  const rows = [...featured, ...trending, ...popular, ...recent];
  // Only emit a cursor when we hit the cap — if all four tiers combined
  // produced fewer than `take` rows, the catalog is genuinely exhausted.
  const last = rows[rows.length - 1];
  const nextCursor = rows.length >= take && last
    ? encodeGroupCursor({ memberCount: last.memberCount, id: last.id })
    : null;
  return {
    data: await attachExploreMembership(host, rows, viewerUserId),
    pagination: { nextCursor },
  };
}

/**
 * Annotate a set of rows with the viewer's membership (status + role) for
 * the explore surface. Pulled out of `listExploreSpotlight` so both the
 * waterfall and cursor branches can share it.
 */
async function attachExploreMembership(
  host: GroupsService,
  rows: Array<{ id: string; createdAt?: Date }>,
  viewerUserId: string | null,
): Promise<ReturnType<typeof toCommunityGroupShellDto>[]> {
  if (!viewerUserId || rows.length === 0) {
    return rows.map((g) => toCommunityGroupShellDto(g as never, null));
  }
  const memberships = await host.prisma.communityGroupMember.findMany({
    where: { userId: viewerUserId, groupId: { in: rows.map((r) => r.id) } },
    select: { groupId: true, status: true, role: true, createdAt: true },
  });
  const byGroup = new Map(memberships.map((m) => [m.groupId, m] as const));
  return [...rows]
    .sort((a, b) => host.compareViewerGroupOrder(a, byGroup.get(a.id), b, byGroup.get(b.id)))
    .map((g) => {
      const m = byGroup.get(g.id);
      const viewerMembership = m ? { status: m.status, role: m.role } : null;
      return toCommunityGroupShellDto(g as never, viewerMembership);
    });
}
