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
    {} as any,
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
