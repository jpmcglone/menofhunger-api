import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroupsService } from './groups.service';

// ─── Deps factory ────────────────────────────────────────────────────────────
//
// GroupsService has 5 collaborators. For the privacy-transition tests below we
// only need `prisma` to respond; the rest are no-op'd. Tests that need deeper
// behavior can override specific fields.

const FAKE_GROUP = {
  id: 'g1',
  slug: 'g',
  name: 'G',
  description: 'desc',
  rules: null,
  coverImageUrl: null,
  avatarImageUrl: null,
  joinPolicy: 'approval' as const,
  memberCount: 1,
  isFeatured: false,
  featuredOrder: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  deletedAt: null,
};

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma: any = {
    communityGroup: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(async (args: any) => ({ ...FAKE_GROUP, ...args.data })),
    },
    communityGroupMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    // searchGroups runs an optional pg_trgm/FTS raw query; default stub returns
    // no augment candidates so tests opt in via override when they care.
    $queryRaw: jest.fn(async () => []),
    ...prismaOverrides,
  };

  const posts: any = {};
  const appConfig: any = { r2: jest.fn(() => null) };
  const notifications: any = {};
  const redis: any = {};

  const service = new GroupsService(prisma, posts, appConfig, notifications, redis);
  return { service, prisma };
}

describe('GroupsService.updateGroup — privacy transitions', () => {
  it('blocks private -> open transition with a BadRequestException', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'approval',
      deletedAt: null,
    });
    // First member lookup: owner permission check.
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'owner',
      status: 'active',
    });

    await expect(
      service.updateGroup({
        viewerUserId: 'owner',
        isSiteAdmin: false,
        groupId: 'g1',
        joinPolicy: 'open',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.communityGroup.update).not.toHaveBeenCalled();
  });

  it('allows open -> private transition (one-way)', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'open',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'owner',
      status: 'active',
    });

    await service.updateGroup({
      viewerUserId: 'owner',
      isSiteAdmin: false,
      groupId: 'g1',
      joinPolicy: 'approval',
    });

    expect(prisma.communityGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'g1' },
        data: expect.objectContaining({ joinPolicy: 'approval' }),
      }),
    );
  });

  it('rejects updates from non-owner non-admin viewers', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'open',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue({
      role: 'member',
      status: 'active',
    });

    await expect(
      service.updateGroup({
        viewerUserId: 'member',
        isSiteAdmin: false,
        groupId: 'g1',
        joinPolicy: 'approval',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when the group does not exist or is deleted', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue(null);
    await expect(
      service.updateGroup({
        viewerUserId: 'owner',
        isSiteAdmin: false,
        groupId: 'gone',
        joinPolicy: 'approval',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('site admin still cannot bypass the private -> open block', async () => {
    const { service, prisma } = makeService();
    prisma.communityGroup.findFirst.mockResolvedValue({
      id: 'g1',
      joinPolicy: 'approval',
      deletedAt: null,
    });
    prisma.communityGroupMember.findUnique.mockResolvedValue(null);

    await expect(
      service.updateGroup({
        viewerUserId: 'admin',
        isSiteAdmin: true,
        groupId: 'g1',
        joinPolicy: 'open',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('GroupsService.searchGroups', () => {
  function makeRow(over: Partial<typeof FAKE_GROUP> = {}) {
    return { ...FAKE_GROUP, ...over };
  }

  it('returns empty when q is too short (after trim)', async () => {
    const findMany = jest.fn();
    const { service } = makeService({ communityGroup: { findMany } });
    const out = await service.searchGroups({
      viewerUserId: null,
      q: '  a  ',
      limit: 20,
      cursor: null,
    });
    expect(out.data).toEqual([]);
    expect(out.pagination.nextCursor).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('only surfaces open groups to anonymous viewers', async () => {
    const findMany: any = jest.fn(async () => []);
    const { service } = makeService({ communityGroup: { findMany } });
    await service.searchGroups({
      viewerUserId: null,
      q: 'fitness',
      limit: 10,
      cursor: null,
    });
    const args = findMany.mock.calls[0][0];
    const ands: any[] = args.where.AND;
    const visibility = ands.find((c: any) => c.joinPolicy === 'open');
    expect(visibility).toEqual({ joinPolicy: 'open' });
  });

  it('lets active members see private groups they belong to', async () => {
    const findMany: any = jest.fn(async () => []);
    const { service } = makeService({ communityGroup: { findMany } });
    await service.searchGroups({
      viewerUserId: 'u1',
      q: 'fitness',
      limit: 10,
      cursor: null,
    });
    const args = findMany.mock.calls[0][0];
    const ands: any[] = args.where.AND;
    const visibility = ands.find((c: any) => Array.isArray(c.OR) && c.OR.length === 2);
    expect(visibility.OR).toEqual(
      expect.arrayContaining([
        { joinPolicy: 'open' },
        { members: { some: { userId: 'u1', status: 'active' } } },
      ]),
    );
  });

  it('excludeMine filters groups the viewer is already in', async () => {
    const findMany: any = jest.fn(async () => []);
    const { service } = makeService({ communityGroup: { findMany } });
    await service.searchGroups({
      viewerUserId: 'u1',
      q: 'fitness',
      limit: 10,
      cursor: null,
      excludeMine: true,
    });
    const args = findMany.mock.calls[0][0];
    const ands: any[] = args.where.AND;
    const exclusion = ands.find((c: any) => c.NOT?.members);
    expect(exclusion).toEqual({
      NOT: { members: { some: { userId: 'u1', status: 'active' } } },
    });
  });

  it('returns a numeric offset nextCursor when more candidates than the page size are ranked', async () => {
    // 5 candidates, limit=2 -> page 1 returns "2" as the offset cursor.
    const candidates = [
      makeRow({ id: 'g1', name: 'fitness club', memberCount: 100 }),
      makeRow({ id: 'g2', name: 'fit life', memberCount: 90 }),
      makeRow({ id: 'g3', name: 'crossfit', memberCount: 80 }),
      makeRow({ id: 'g4', name: 'unfit', memberCount: 70 }),
      makeRow({ id: 'g5', name: 'fit and fab', memberCount: 60 }),
    ];
    const findMany: any = jest.fn(async () => candidates);
    const { service } = makeService({ communityGroup: { findMany } });

    const page1 = await service.searchGroups({
      viewerUserId: null,
      q: 'fit',
      limit: 2,
      cursor: null,
    });
    expect(page1.data).toHaveLength(2);
    expect(page1.pagination.nextCursor).toBe('2');

    const page2 = await service.searchGroups({
      viewerUserId: null,
      q: 'fit',
      limit: 2,
      cursor: page1.pagination.nextCursor,
    });
    expect(page2.data).toHaveLength(2);
    expect(page2.pagination.nextCursor).toBe('4');

    const page3 = await service.searchGroups({
      viewerUserId: null,
      q: 'fit',
      limit: 2,
      cursor: page2.pagination.nextCursor,
    });
    expect(page3.data).toHaveLength(1);
    expect(page3.pagination.nextCursor).toBeNull();
  });

  it('returns null nextCursor when there is no next page', async () => {
    const findMany: any = jest.fn(async () => [makeRow({ id: 'g1' })]);
    const { service } = makeService({ communityGroup: { findMany } });
    const page = await service.searchGroups({
      viewerUserId: null,
      q: 'fit',
      limit: 10,
      cursor: null,
    });
    expect(page.pagination.nextCursor).toBeNull();
  });

  it('ranks an exact name match above a member-heavy substring match', async () => {
    // Without ranking, `popular` (100 members) would always win the order.
    // With ranking, `exact` should sit on top because its name matches the
    // query exactly.
    const candidates = [
      makeRow({ id: 'popular', name: 'Yoga and chill', memberCount: 1000 }),
      makeRow({ id: 'exact', name: 'yoga', memberCount: 5 }),
      makeRow({ id: 'desc-only', name: 'Stretching', description: 'we sometimes do yoga', memberCount: 50 }),
    ];
    const findMany: any = jest.fn(async () => candidates);
    const { service } = makeService({ communityGroup: { findMany } });

    const page = await service.searchGroups({
      viewerUserId: null,
      q: 'yoga',
      limit: 5,
      cursor: null,
    });
    const ids = page.data.map((g: any) => g.id);
    expect(ids[0]).toBe('exact');
    expect(ids).toContain('popular');
    expect(ids).toContain('desc-only');
  });

  it('matches every word of a multi-word query across different fields', async () => {
    // The OR set fans out per-word so "morning yoga" should match a group
    // whose name says "Yoga" and whose description mentions "morning".
    const findMany: any = jest.fn(async () => [
      makeRow({ id: 'yoga', name: 'Yoga', description: 'morning sessions in the park', memberCount: 10 }),
    ]);
    const { service } = makeService({ communityGroup: { findMany } });

    await service.searchGroups({
      viewerUserId: null,
      q: 'morning yoga',
      limit: 5,
      cursor: null,
    });
    const args = findMany.mock.calls[0][0];
    const ands: any[] = args.where.AND;
    const orClause = ands.find((c: any) => Array.isArray(c.OR));
    const conditions: any[] = orClause.OR;
    // Per-word ILIKE clauses for both "morning" and "yoga" must be present.
    const hasWord = (word: string, field: string) =>
      conditions.some((c: any) => c[field]?.contains === word);
    expect(hasWord('morning', 'name')).toBe(true);
    expect(hasWord('yoga', 'name')).toBe(true);
    expect(hasWord('morning', 'description')).toBe(true);
    expect(hasWord('yoga', 'description')).toBe(true);
    expect(hasWord('morning', 'rules')).toBe(true);
    expect(hasWord('yoga', 'rules')).toBe(true);
  });

  it('merges fuzzy/FTS augment candidates with the substring primary set', async () => {
    // Primary substring path returns nothing (the user typo'd "stocism").
    // The trigram raw query catches the real group ("stoicism") and the
    // service hydrates it with the same visibility filter.
    const calls: any[] = [];
    const findMany: any = jest.fn(async (args: any) => {
      calls.push(args);
      // Call 0: primary substring path -> no rows.
      // Call 1: augment hydration for trigram-found IDs -> the real group.
      if (calls.length === 1) return [];
      return [makeRow({ id: 'g-stoicism', name: 'Stoicism', memberCount: 200 })];
    });
    const $queryRaw: any = jest.fn(async () => [{ id: 'g-stoicism' }]);
    const { service } = makeService({
      communityGroup: { findMany },
      $queryRaw,
    });

    const page = await service.searchGroups({
      viewerUserId: null,
      q: 'stocism',
      limit: 10,
      cursor: null,
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const ids = page.data.map((g: any) => g.id);
    expect(ids).toEqual(['g-stoicism']);
    // Augment hydration must reapply the same baseAnd (deletedAt + visibility)
    // so private groups don't leak through fuzzy matching.
    const hydrationArgs = calls[1];
    const ands: any[] = hydrationArgs.where.AND;
    expect(ands.find((c: any) => c.deletedAt === null)).toBeTruthy();
    expect(ands.find((c: any) => c.joinPolicy === 'open')).toBeTruthy();
    expect(ands.find((c: any) => c.id?.in)).toEqual({ id: { in: ['g-stoicism'] } });
  });

  it('falls back gracefully when the raw fuzzy/FTS query throws', async () => {
    // Fresh databases (or environments without pg_trgm) shouldn't 500 the
    // search endpoint — they should just return substring results.
    const findMany: any = jest.fn(async () => [
      makeRow({ id: 'g1', name: 'Fitness', memberCount: 5 }),
    ]);
    const $queryRaw: any = jest.fn(async () => {
      throw new Error('function similarity(text, text) does not exist');
    });
    const { service } = makeService({
      communityGroup: { findMany },
      $queryRaw,
    });

    const page = await service.searchGroups({
      viewerUserId: null,
      q: 'fit',
      limit: 5,
      cursor: null,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe('g1');
  });

  it('sorts groups the viewer owns to the very top, ahead of higher-scoring matches', async () => {
    // Without owner-first sort, `exact` (exact name match, score 100) would
    // beat `owned` (description-only match, score ~30). With owner-first
    // sort, `owned` should lead.
    const candidates = [
      makeRow({ id: 'exact', name: 'fitness', memberCount: 5 }),
      makeRow({ id: 'owned', name: 'cycling', description: 'fitness on wheels', memberCount: 200 }),
      makeRow({ id: 'popular', name: 'Fit Life', memberCount: 1000 }),
    ];
    const findMany: any = jest.fn(async () => candidates);
    const memberFindMany: any = jest.fn(async () => [
      { groupId: 'owned', status: 'active', role: 'owner' },
    ]);
    const { service } = makeService({
      communityGroup: { findMany },
      communityGroupMember: { findMany: memberFindMany, findUnique: jest.fn() },
    });

    const page = await service.searchGroups({
      viewerUserId: 'u1',
      q: 'fitness',
      limit: 5,
      cursor: null,
    });
    const ids = page.data.map((g: any) => g.id);
    expect(ids[0]).toBe('owned');
    expect(ids).toContain('exact');
    expect(ids).toContain('popular');
  });

  it('skips the fuzzy/FTS raw query for very short single-word queries', async () => {
    const findMany: any = jest.fn(async () => []);
    const $queryRaw: any = jest.fn(async () => []);
    const { service } = makeService({
      communityGroup: { findMany },
      $queryRaw,
    });

    await service.searchGroups({
      viewerUserId: null,
      q: 'fi', // 2 chars, single word -> below trigram + FTS thresholds
      limit: 10,
      cursor: null,
    });
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

// ─── listExploreSpotlight ────────────────────────────────────────────────────
// Discover should never come back empty when the system has joinable groups.
// The method walks featured -> trending -> popular -> recent until `take` is
// reached, and respects `excludeMine` so the surface only contains groups the
// viewer can actually join.

describe('GroupsService.listExploreSpotlight', () => {
  function makeRow(overrides: Partial<typeof FAKE_GROUP> = {}) {
    return { ...FAKE_GROUP, ...overrides } as typeof FAKE_GROUP;
  }

  function setup(prismaOverrides: Record<string, any> = {}) {
    return makeService({
      communityGroup: {
        findFirst: jest.fn(),
        findMany: jest.fn(async () => []),
        update: jest.fn(),
      },
      communityGroupMember: {
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
      },
      post: {
        groupBy: jest.fn(async () => []),
      },
      ...prismaOverrides,
    });
  }

  it('excludeMine=true threads the viewer\'s group ids into every tier query', async () => {
    const findMany: any = jest.fn(async () => []);
    const memberFindMany: any = jest.fn(async () => [
      { groupId: 'mine1' },
      { groupId: 'mine2' },
    ]);
    const groupBy: any = jest.fn(async () => []);
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
      communityGroupMember: { findUnique: jest.fn(), findMany: memberFindMany },
      post: { groupBy },
    });

    await service.listExploreSpotlight('viewer-1', { excludeMine: true });

    expect(memberFindMany).toHaveBeenCalledWith({
      where: { userId: 'viewer-1', status: 'active' },
      select: { groupId: true },
    });
    // Every group findMany call must exclude mine ids
    for (const call of findMany.mock.calls as any[]) {
      const where = call[0]?.where ?? {};
      expect(where.id?.notIn).toEqual(expect.arrayContaining(['mine1', 'mine2']));
    }
    // The trending groupBy must also exclude mine
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          communityGroupId: expect.objectContaining({ notIn: ['mine1', 'mine2'] }),
        }),
      }),
    );
  });

  it('excludeMine=true keeps mineIds excluded in later tiers even after seenIds is populated', async () => {
    // Regression: when Tier 1 (featured) returns rows, `seenIds` was being
    // spread as `{ id: { notIn: [...seenIds] } }` over `baseExclude.id`,
    // *clobbering* the `notIn: mineIds` filter. That let groups the viewer
    // already owns/joined leak through Tiers 3/4.
    let call = 0;
    const findMany: any = jest.fn(async () => {
      call += 1;
      // Calls in order: 1=featured, 2=popular, 3=recent, 4=viewer-membership-annotation
      if (call === 1) return [makeRow({ id: 'feat1' }), makeRow({ id: 'feat2' })];
      return [];
    });
    const memberFindMany: any = jest.fn(async () => [
      { groupId: 'mine1' },
      { groupId: 'mine2' },
    ]);
    const groupBy: any = jest.fn(async () => []);
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
      communityGroupMember: { findUnique: jest.fn(), findMany: memberFindMany },
      post: { groupBy },
    });

    await service.listExploreSpotlight('viewer-1', { excludeMine: true });

    // The Popular query (2nd findMany call) MUST still exclude mineIds even
    // though seenIds now contains feat1/feat2.
    const popularCall = (findMany.mock.calls as any[])[1];
    const popularNotIn: string[] = popularCall[0].where?.id?.notIn ?? [];
    expect(popularNotIn).toEqual(expect.arrayContaining(['mine1', 'mine2', 'feat1', 'feat2']));

    // Same for the Recent query (3rd findMany call).
    const recentCall = (findMany.mock.calls as any[])[2];
    const recentNotIn: string[] = recentCall[0].where?.id?.notIn ?? [];
    expect(recentNotIn).toEqual(expect.arrayContaining(['mine1', 'mine2', 'feat1', 'feat2']));
  });

  it('excludeMine=false (default) does not query the viewer\'s memberships', async () => {
    const memberFindMany: any = jest.fn(async () => []);
    const { service } = setup({
      communityGroupMember: { findUnique: jest.fn(), findMany: memberFindMany },
    });
    await service.listExploreSpotlight('viewer-1');
    // The first call here is the post-tier "viewer membership annotation" lookup,
    // NOT the excludeMine prefetch. We can distinguish: the prefetch query selects
    // only { groupId }, while the annotation lookup selects { groupId, status, role }.
    const prefetchCalls = (memberFindMany.mock.calls as any[]).filter(
      (c) => c[0]?.where?.status === 'active' && c[0]?.select?.status === undefined,
    );
    expect(prefetchCalls).toHaveLength(0);
  });

  it('falls through tiers and returns rows from the deepest tier when earlier ones are empty', async () => {
    // Featured: empty. Trending: empty. Popular: empty. Recent: returns 2 rows.
    let call = 0;
    const findMany: any = jest.fn(async () => {
      call += 1;
      // Calls in order:
      //   1: featured
      //   2: popular
      //   3: recent
      //   4: viewer membership annotation
      if (call === 3) return [makeRow({ id: 'r1' }), makeRow({ id: 'r2' })];
      return [];
    });
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
    });

    const out = await service.listExploreSpotlight(null);
    expect(out.data.map((g: any) => g.id)).toEqual(['r1', 'r2']);
  });

  it('returns trending rows in heat order, not Prisma `in` order', async () => {
    const heatOrderedIds = ['hot1', 'hot2', 'hot3'];
    const groupBy: any = jest.fn(async () =>
      heatOrderedIds.map((id) => ({ communityGroupId: id, _count: { _all: 1 } })),
    );
    const findMany: any = jest.fn(async (args: any) => {
      // Featured tier comes back empty.
      if (args?.where?.isFeatured) return [];
      // Trending hydration: where = { AND: [exclude, { id: { in: heatIds } }] }.
      // (Pre-fix this was `where: { ...baseExclude, id: { in: heatIds } }` — we
      // switched to AND so the `in: heatIds` filter doesn't clobber the
      // `notIn: mineIds` exclusion that lives in the same `id` slot.)
      const andClauses: any[] = Array.isArray(args?.where?.AND) ? args.where.AND : [];
      const wantsHeatHydration = andClauses.some((c) => Array.isArray(c?.id?.in));
      if (wantsHeatHydration) {
        return [makeRow({ id: 'hot3' }), makeRow({ id: 'hot1' }), makeRow({ id: 'hot2' })];
      }
      return [];
    });
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
      post: { groupBy },
    });

    const out = await service.listExploreSpotlight(null);
    expect(out.data.map((g: any) => g.id)).toEqual(heatOrderedIds);
  });

  it('first page returns nextCursor when the waterfall fills `take`', async () => {
    // 3 popular rows fill `take=3`. nextCursor must be encoded from the
    // LAST row's (memberCount, id).
    const findMany: any = jest.fn(async (args: any) => {
      // featured: empty
      if (args?.where?.isFeatured) return [];
      // popular call (orderBy memberCount desc) — fill the cap exactly
      if (args?.orderBy?.[0]?.memberCount === 'desc') {
        return [
          makeRow({ id: 'p1', memberCount: 100 }),
          makeRow({ id: 'p2', memberCount: 50 }),
          makeRow({ id: 'p3', memberCount: 10 }),
        ];
      }
      return [];
    });
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
    });

    const out = await service.listExploreSpotlight(null, { take: 3 });
    expect(out.data.map((g: any) => g.id)).toEqual(['p1', 'p2', 'p3']);
    expect(out.pagination.nextCursor).not.toBeNull();
    // The cursor should round-trip to the last row's coordinates.
    const decoded = JSON.parse(
      Buffer.from(out.pagination.nextCursor as string, 'base64url').toString('utf8'),
    );
    expect(decoded).toEqual({ memberCount: 10, id: 'p3' });
  });

  it('first page returns nextCursor=null when the waterfall is exhausted', async () => {
    // Only 1 row total; take=3 so we don't hit the cap.
    const findMany: any = jest.fn(async (args: any) => {
      if (args?.where?.isFeatured) return [];
      if (args?.orderBy?.[0]?.memberCount === 'desc') {
        return [makeRow({ id: 'p1', memberCount: 5 })];
      }
      return [];
    });
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
    });

    const out = await service.listExploreSpotlight(null, { take: 3 });
    expect(out.data.map((g: any) => g.id)).toEqual(['p1']);
    expect(out.pagination.nextCursor).toBeNull();
  });

  it('cursor pagination uses simple memberCount-desc keyset (no waterfall)', async () => {
    // Encode a cursor pointing at the last row of "page 1": memberCount=10, id='p3'.
    // The next page should:
    //  - skip the tiered waterfall entirely
    //  - filter `(memberCount, id) < cursor` via OR on memberCount/id
    //  - order by memberCount desc, id desc
    //  - take limit + 1 to detect hasMore
    const cursor = Buffer.from(
      JSON.stringify({ memberCount: 10, id: 'p3' }),
      'utf8',
    ).toString('base64url');

    let capturedArgs: any = null;
    const findMany: any = jest.fn(async (args: any) => {
      capturedArgs = args;
      return [
        makeRow({ id: 'p4', memberCount: 9 }),
        makeRow({ id: 'p5', memberCount: 5 }),
      ];
    });
    const { service } = setup({
      communityGroup: { findFirst: jest.fn(), findMany, update: jest.fn() },
    });

    const out = await service.listExploreSpotlight(null, { take: 3, cursor });

    expect(out.data.map((g: any) => g.id)).toEqual(['p4', 'p5']);
    expect(out.pagination.nextCursor).toBeNull(); // 2 rows < take+1 = 4 → no more
    expect(capturedArgs.orderBy).toEqual([{ memberCount: 'desc' }, { id: 'desc' }]);
    expect(capturedArgs.take).toBe(4); // take + 1
    // The where clause must contain the keyset OR-condition under AND.
    const andClauses = capturedArgs.where?.AND ?? [];
    const cursorClause = andClauses.find((c: any) => Array.isArray(c.OR));
    expect(cursorClause?.OR).toEqual([
      { memberCount: { lt: 10 } },
      { memberCount: 10, id: { lt: 'p3' } },
    ]);
  });
});
