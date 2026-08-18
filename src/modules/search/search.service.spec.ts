import { SearchService } from './search.service';

function makeService(viewer: any = null) {
  const prisma: any = {
    post: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(async () => []),
  };
  const posts: any = {
    ensureBoostScoresFresh: jest.fn(async () => new Map()),
    computeScoresForPostIds: jest.fn(async () => new Map()),
  };
  const viewerContext: any = {
    getViewer: jest.fn(async () => viewer),
    isVerified: jest.fn((v: any) => Boolean(v?.verifiedStatus && v.verifiedStatus !== 'none')),
    allowedPostVisibilities: jest.fn((v: any) => {
      const allowed = ['public'];
      if (v?.verifiedStatus && v.verifiedStatus !== 'none') allowed.push('verifiedOnly');
      if (v?.premium || v?.premiumPlus) allowed.push('premiumOnly');
      return allowed;
    }),
  };

  const service = new SearchService(
    prisma,
    {} as any,
    posts,
    { ensureArticleBoostScoresFresh: async () => {} } as any,
    viewerContext,
    { isValid: () => false, searchPrefix: async () => [] } as any,
  );

  return { service, prisma, posts, viewerContext };
}

function readableGroupFilterFromFindMany(prisma: any) {
  const call = prisma.post.findMany.mock.calls[0]?.[0];
  const ands = call?.where?.AND ?? [];
  return ands.find((part: any) => part?.communityGroupId === null || Array.isArray(part?.OR));
}

describe('SearchService.searchPosts — community group visibility', () => {
  it('keeps anonymous search scoped to non-group posts', async () => {
    const { service, prisma } = makeService(null);

    await service.searchPosts({ viewerUserId: null, q: 'go', limit: 10, cursor: null });

    expect(readableGroupFilterFromFindMany(prisma)).toEqual({ communityGroupId: null });
  });

  it('lets verified signed-in viewers search open group posts', async () => {
    const { service, prisma } = makeService({
      id: 'u1',
      verifiedStatus: 'verified',
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    });

    await service.searchPosts({ viewerUserId: 'u1', q: 'go', limit: 10, cursor: null });

    const filter = readableGroupFilterFromFindMany(prisma);
    expect(filter.OR).toContainEqual({ communityGroupId: null });
    expect(filter.OR).toContainEqual({ communityGroup: { deletedAt: null, joinPolicy: 'open' } });
  });

  it('lets active members search private group posts without broadly exposing private groups', async () => {
    const { service, prisma } = makeService({
      id: 'u1',
      verifiedStatus: 'none',
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    });

    await service.searchPosts({ viewerUserId: 'u1', q: 'go', limit: 10, cursor: null });

    const filter = readableGroupFilterFromFindMany(prisma);
    const serialized = JSON.stringify(filter);
    expect(serialized).toContain('"members"');
    expect(serialized).toContain('"userId":"u1"');
    expect(serialized).toContain('"status":"active"');
    expect(serialized).not.toContain('"joinPolicy":"approval"');
    expect(filter.OR).not.toContainEqual({ communityGroup: { deletedAt: null, joinPolicy: 'open' } });
  });

  it('does not include onlyMe posts in the FTS SQL branch', async () => {
    const { service, prisma } = makeService({
      id: 'u1',
      verifiedStatus: 'verified',
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    });

    await service.searchPosts({ viewerUserId: 'u1', q: 'alpha', limit: 10, cursor: null });

    const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('CommunityGroup');
    expect(sql).toContain('joinPolicy');
    expect(sql).not.toContain('onlyMe');
  });
});

describe('SearchService.searchCommunityGroups — group visibility', () => {
  function makeGroupService(_viewerUserId: string | null = null) {
    const openGroup = { id: 'g-open', name: 'Open Group', slug: 'open-group', joinPolicy: 'open', createdAt: new Date(), memberCount: 1, description: null, rules: null, coverImageUrl: null, avatarImageUrl: null, isFeatured: false, featuredOrder: null };
    const privateGroup = { id: 'g-private', name: 'Private Group', slug: 'private-group', joinPolicy: 'approval', createdAt: new Date(), memberCount: 1, description: null, rules: null, coverImageUrl: null, avatarImageUrl: null, isFeatured: false, featuredOrder: null };

    const prisma: any = {
      communityGroup: {
        findMany: jest.fn(async () => [openGroup]),
      },
      communityGroupMember: {
        findMany: jest.fn(async () => []),
      },
    };

    const service = new SearchService(prisma, {} as any, {} as any, { ensureArticleBoostScoresFresh: async () => {} } as any, {
      getViewer: jest.fn(async () => null),
      isVerified: jest.fn(() => true),
      allowedPostVisibilities: jest.fn(() => ['public']),
    } as any, { isValid: () => false, searchPrefix: async () => [] } as any);

    return { service, prisma, openGroup, privateGroup };
  }

  it('limits anonymous viewers to open-joinPolicy groups only', async () => {
    const { service, prisma } = makeGroupService(null);

    await service.searchCommunityGroups({ viewerUserId: null, q: 'group', limit: 10 });

    const call = prisma.communityGroup.findMany.mock.calls[0]?.[0];
    const andClauses = call?.where?.AND ?? [];

    // The visibility clause must be a simple `{ joinPolicy: 'open' }` (no OR, no member check).
    const visClause = andClauses.find((c: any) => c?.joinPolicy === 'open');
    expect(visClause).toBeDefined();

    // Must NOT have a visibility OR that includes a members-based branch.
    const orWithMembers = andClauses
      .filter((c: any) => Array.isArray(c?.OR))
      .flatMap((c: any) => c.OR as any[])
      .find((o: any) => o?.members !== undefined);
    expect(orWithMembers).toBeUndefined();
  });

  it('lets authenticated users see open groups OR groups they belong to', async () => {
    const { service, prisma } = makeGroupService('u1');

    await service.searchCommunityGroups({ viewerUserId: 'u1', q: 'group', limit: 10 });

    const call = prisma.communityGroup.findMany.mock.calls[0]?.[0];
    const andClauses = call?.where?.AND ?? [];

    // Must have an OR visibility clause that includes both open-groups and member check.
    const visClause = andClauses.find(
      (c: any) => Array.isArray(c?.OR) && c.OR.some((o: any) => o?.joinPolicy === 'open') && c.OR.some((o: any) => o?.members),
    );
    expect(visClause).toBeDefined();

    const or = visClause.OR as any[];
    expect(or).toContainEqual({ joinPolicy: 'open' });
    const memberBranch = or.find((o: any) => o?.members);
    expect(memberBranch).toBeDefined();
    expect(memberBranch.members.some.userId).toBe('u1');
    expect(memberBranch.members.some.status).toBe('active');
  });
});

describe('SearchService.recordUserSearch', () => {
  function makeRecordService() {
    const rows: any[] = [];
    const prisma: any = {
      post: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []),
      userSearch: {
        findFirst: jest.fn(async (args: any) => {
          const filtered = rows.filter((r) => {
            if (args.where.userId && r.userId !== args.where.userId) return false;
            if ('targetUserId' in args.where) {
              if (args.where.targetUserId === null && r.targetUserId !== null) return false;
              if (args.where.targetUserId && r.targetUserId !== args.where.targetUserId) return false;
            }
            return true;
          });
          filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return filtered[0] ?? null;
        }),
        create: jest.fn(async (args: any) => {
          const row = { id: `row-${rows.length}`, createdAt: new Date(), ...args.data };
          rows.push(row);
          return row;
        }),
      },
    };
    const service = new SearchService(
      prisma,
      {} as any,
      { ensureBoostScoresFresh: async () => new Map(), computeScoresForPostIds: async () => new Map() } as any,
      { ensureArticleBoostScoresFresh: async () => {} } as any,
      { getViewer: async () => null, isVerified: () => false, allowedPostVisibilities: () => ['public'] } as any,
      { isValid: () => false, searchPrefix: async () => [] } as any,
    );
    return { service, prisma, rows };
  }

  it('creates a row for a typed query', async () => {
    const { service, prisma } = makeRecordService();
    await service.recordUserSearch({ userId: 'u1', query: 'hello' });
    expect(prisma.userSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', query: 'hello' }) }),
    );
  });

  it('dedupes identical text queries within 30 minutes', async () => {
    const { service, prisma } = makeRecordService();
    await service.recordUserSearch({ userId: 'u1', query: 'hello' });
    await service.recordUserSearch({ userId: 'u1', query: 'hello' });
    expect(prisma.userSearch.create).toHaveBeenCalledTimes(1);
  });

  it('creates a row for a profile tap with targetUserId', async () => {
    const { service, prisma } = makeRecordService();
    await service.recordUserSearch({ userId: 'u1', query: '@bob', targetUserId: 'u2' });
    expect(prisma.userSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetUserId: 'u2' }) }),
    );
  });

  it('dedupes repeated profile taps on the same target within 30 minutes', async () => {
    const { service, prisma } = makeRecordService();
    await service.recordUserSearch({ userId: 'u1', query: '@bob', targetUserId: 'u2' });
    await service.recordUserSearch({ userId: 'u1', query: '@bob', targetUserId: 'u2' });
    expect(prisma.userSearch.create).toHaveBeenCalledTimes(1);
  });

  it('allows re-recording a profile tap after 30 minutes', async () => {
    const { service, prisma, rows } = makeRecordService();
    await service.recordUserSearch({ userId: 'u1', query: '@bob', targetUserId: 'u2' });
    // Backdate the row to 31 minutes ago.
    rows[0].createdAt = new Date(Date.now() - 1000 * 60 * 31);
    await service.recordUserSearch({ userId: 'u1', query: '@bob', targetUserId: 'u2' });
    expect(prisma.userSearch.create).toHaveBeenCalledTimes(2);
  });
});

describe('SearchService.searchUsers — ranking', () => {
  function makeUser(overrides: Partial<{
    id: string; username: string; name: string; bio: string;
    premium: boolean; premiumPlus: boolean; isOrganization: boolean; verifiedStatus: string;
    avatarKey: null; avatarUpdatedAt: null; lastOnlineAt: Date | null; createdAt: Date;
  }>) {
    return {
      id: overrides.id ?? 'u1',
      createdAt: overrides.createdAt ?? new Date('2024-01-01'),
      username: overrides.username ?? null,
      name: overrides.name ?? null,
      bio: overrides.bio ?? null,
      premium: overrides.premium ?? false,
      premiumPlus: overrides.premiumPlus ?? false,
      isOrganization: overrides.isOrganization ?? false,
      verifiedStatus: (overrides.verifiedStatus ?? 'none') as any,
      avatarKey: null,
      avatarUpdatedAt: null,
      lastOnlineAt: overrides.lastOnlineAt ?? null,
    };
  }

  function makeSearchService(users: ReturnType<typeof makeUser>[]) {
    const prisma: any = {
      userBlock: { findMany: jest.fn(async () => []) },
      user: { findMany: jest.fn(async () => users), findUnique: jest.fn(async () => null) },
      userOrgMembership: { findMany: jest.fn(async () => []) },
      crewMember: { findMany: jest.fn(async () => []) },
    };
    const follows: any = {
      batchRelationshipForUserIds: jest.fn(async () => ({
        viewerFollows: new Set(),
        followsViewer: new Set(),
        viewerBellEnabled: new Set(),
      })),
    };
    const service = new SearchService(
      prisma,
      follows,
      { ensureBoostScoresFresh: async () => new Map(), computeScoresForPostIds: async () => new Map() } as any,
      { ensureArticleBoostScoresFresh: async () => {} } as any,
      { getViewer: async () => null, isVerified: () => false, allowedPostVisibilities: () => ['public'] } as any,
      { isValid: () => false, searchPrefix: async () => [] } as any,
    );
    return { service };
  }

  it('strips leading @ so @john matches username "john"', async () => {
    const { service } = makeSearchService([
      makeUser({ id: 'u1', username: 'john' }),
    ]);
    const result = await service.searchUsers({ q: '@john', limit: 10, cursor: null, viewerUserId: null });
    expect(result.users).toHaveLength(1);
    expect(result.users[0]!.username).toBe('john');
  });

  it('ranks closer username prefix matches higher within the same tier', async () => {
    // "joe" starts both usernames; shorter one is a closer match
    const users = [
      makeUser({ id: 'u_long', username: 'joe_black_account_12345' }),
      makeUser({ id: 'u_short', username: 'joe_s' }),
    ];
    const { service } = makeSearchService(users);
    const result = await service.searchUsers({ q: 'joe', limit: 10, cursor: null, viewerUserId: null });
    const usernames = result.users.map((u) => u.username);
    expect(usernames.indexOf('joe_s')).toBeLessThan(usernames.indexOf('joe_black_account_12345'));
  });

  it('ranks exact username match above prefix matches', async () => {
    const users = [
      makeUser({ id: 'u_exact', username: 'joe' }),
      makeUser({ id: 'u_prefix', username: 'joe_smith' }),
    ];
    const { service } = makeSearchService(users);
    const result = await service.searchUsers({ q: 'joe', limit: 10, cursor: null, viewerUserId: null });
    expect(result.users[0]!.username).toBe('joe');
  });
});
