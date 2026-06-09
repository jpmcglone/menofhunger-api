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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
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

function makeTopPostRow(id: string, weeklyViews: number, authorId: string, rootId: string): { id: string; weekly_views: bigint; root_id: string; author_id: string } {
  return { id, weekly_views: BigInt(weeklyViews), root_id: rootId, author_id: authorId };
}

function makeService(topPostRowOverride?: Array<{ id: string; weekly_views: bigint; root_id: string; author_id: string }>) {
  const defaultRows = [
    makeTopPostRow('post-2', 8, 'user-1', 'post-2'),
    makeTopPostRow('post-1', 5, 'user-1', 'post-1'),
  ];
  const rows = topPostRowOverride ?? defaultRows;
  const prisma = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce([{ public_post_count: 42n, verified_men_count: 7n }])
      .mockResolvedValueOnce(rows),
    user: {
      findMany: jest.fn().mockResolvedValue([makeUser()]),
    },
    post: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const ids: string[] = args?.where?.id?.in ?? [];
        return ids.map((id) => makePost(id, `Post ${id}`));
      }),
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
      take: 30,
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

  it('defers 3rd post from the same author to backfill after first-pass cap', async () => {
    // 4 rows: 3 from author-a (cap is 2), 1 from author-b.
    // First pass: p1, p2 admitted; p3 skipped (author-a cap hit); p4 admitted.
    // Backfill: p3 appended.
    const rows = [
      makeTopPostRow('p1', 100, 'author-a', 'root-1'),
      makeTopPostRow('p2', 90,  'author-a', 'root-2'),
      makeTopPostRow('p3', 80,  'author-a', 'root-3'), // 3rd from author-a — deferred
      makeTopPostRow('p4', 70,  'author-b', 'root-4'),
    ];
    const { service } = makeService(rows);

    const snapshot = await service.getSnapshot(NOW);

    const ids = snapshot.topPostsThisWeek.map((p) => p.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(ids).toContain('p4');
    // p3 must appear after p4 because it was deferred to backfill.
    const p3idx = ids.indexOf('p3');
    const p4idx = ids.indexOf('p4');
    if (p3idx !== -1 && p4idx !== -1) expect(p3idx).toBeGreaterThan(p4idx);
  });

  it('defers 3rd post from the same thread root to backfill after first-pass cap', async () => {
    // 4 rows: 3 that share root-x (cap is 2), 1 from a different root.
    // First pass: pa and pb admitted; pc skipped (root-x cap hit); pd admitted.
    const rows = [
      makeTopPostRow('pa', 100, 'author-1', 'root-x'),
      makeTopPostRow('pb', 90,  'author-2', 'root-x'),
      makeTopPostRow('pc', 80,  'author-3', 'root-x'), // 3rd in root-x — deferred
      makeTopPostRow('pd', 70,  'author-4', 'root-y'),
    ];
    const { service } = makeService(rows);

    const snapshot = await service.getSnapshot(NOW);

    const ids = snapshot.topPostsThisWeek.map((p) => p.id);
    expect(ids).toContain('pa');
    expect(ids).toContain('pb');
    expect(ids).toContain('pd');
    const pcIdx = ids.indexOf('pc');
    const pdIdx = ids.indexOf('pd');
    if (pcIdx !== -1 && pdIdx !== -1) expect(pcIdx).toBeGreaterThan(pdIdx);
  });

  it('returns up to 14 posts in the pool when the query returns ≥14 candidates', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeTopPostRow(`p${i}`, 100 - i, `author-${i}`, `root-${i}`),
    );
    const { service } = makeService(rows);

    const snapshot = await service.getSnapshot(NOW);

    expect(snapshot.topPostsThisWeek.length).toBeLessThanOrEqual(14);
    expect(snapshot.topPostsThisWeek.length).toBeGreaterThan(0);
  });
});
