import { LandingService } from './landing.service';

const NOW = new Date('2026-04-25T03:00:00.000Z');

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    username: 'joseph',
    name: 'Joseph',
    premium: false,
    premiumPlus: false,
    isOrganization: false,
    stewardBadgeEnabled: true,
    verifiedStatus: 'manual',
    avatarKey: null,
    avatarUpdatedAt: null,
    bannedAt: null,
    orgMemberships: [],
    ...overrides,
  };
}

function makePost(id: string, body: string) {
  return {
    id,
    createdAt: new Date('2026-04-24T12:00:00.000Z'),
    editedAt: null,
    editCount: 0,
    deletedAt: null,
    body,
    isDraft: false,
    topics: [],
    hashtags: [],
    hashtagCasings: [],
    kind: 'regular',
    checkinDayKey: null,
    checkinPrompt: null,
    visibility: 'public',
    boostCount: 2,
    bookmarkCount: 0,
    commentCount: 1,
    repostCount: 0,
    viewerCount: 12,
    weightedViewCount: 12,
    boostScore: null,
    boostScoreUpdatedAt: null,
    trendingScore: null,
    trendingScoreUpdatedAt: null,
    userId: 'user-1',
    communityGroupId: null,
    pinnedInGroupAt: null,
    parentId: null,
    rootId: null,
    repostedPostId: null,
    articleId: null,
    quotedPostId: null,
    user: makeUser(),
    media: [],
    mentions: [],
    poll: null,
    article: null,
  };
}

function makeService() {
  const prisma = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce([{ public_post_count: 42n, verified_men_count: 7n }])
      .mockResolvedValueOnce([
        { id: 'post-2', weekly_views: 8n },
        { id: 'post-1', weekly_views: 5n },
      ]),
    user: {
      findMany: jest.fn().mockResolvedValue([makeUser()]),
    },
    post: {
      findMany: jest.fn().mockResolvedValue([
        makePost('post-1', 'Second ranked post'),
        makePost('post-2', 'Top ranked post'),
      ]),
    },
  };
  const config = {
    r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.example.test' })),
  };
  const articles = {
    listTrending: jest.fn().mockResolvedValue([{ id: 'article-1', title: 'Trending' }]),
  };
  const service = new LandingService(prisma as any, config as any, articles as any);
  return { service, prisma, articles };
}

describe('LandingService', () => {
  it('builds a public landing snapshot without exact activity timestamps', async () => {
    const { service, prisma, articles } = makeService();

    const snapshot = await service.getSnapshot(NOW);

    expect(snapshot.stats).toEqual({ publicPostCount: 42, verifiedMenCount: 7 });
    expect(snapshot.recentlyActiveMen).toEqual([
      expect.objectContaining({
        id: 'user-1',
        username: 'joseph',
        isOrganization: false,
        verifiedStatus: 'manual',
      }),
    ]);
    expect(snapshot.recentlyActiveMen[0]).not.toHaveProperty('lastOnlineAt');
    expect(snapshot.recentlyActiveMen[0]).not.toHaveProperty('lastSeenAt');
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        bannedAt: null,
        usernameIsSet: true,
        isOrganization: false,
        verifiedStatus: { not: 'none' },
      }),
      take: 10,
    }));
    expect(articles.listTrending).toHaveBeenCalledWith({ viewerUserId: null, limit: 3 });
  });

  it('preserves the weekly top-post order from the ranking query', async () => {
    const { service, prisma } = makeService();

    const snapshot = await service.getSnapshot(NOW);

    expect(prisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['post-2', 'post-1'] } },
    }));
    expect(snapshot.topPostsThisWeek.map((post) => ({ id: post.id, weeklyViewCount: post.weeklyViewCount }))).toEqual([
      { id: 'post-2', weeklyViewCount: 8 },
      { id: 'post-1', weeklyViewCount: 5 },
    ]);
  });
});
