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
    viewerContext,
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

    const service = new SearchService(prisma, {} as any, {} as any, {
      getViewer: jest.fn(async () => null),
      isVerified: jest.fn(() => true),
      allowedPostVisibilities: jest.fn(() => ['public']),
    } as any);

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
