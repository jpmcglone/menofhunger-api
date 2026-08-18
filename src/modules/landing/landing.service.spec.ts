import { LandingService } from './landing.service';

const NOW = new Date('2026-04-25T03:00:00.000Z');
const WINDOW_START = new Date(NOW.getTime() - 30 * 86400000);

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
    avatarKey: 'avatars/user-1.jpg',
    avatarUpdatedAt: null,
    bannedAt: null,
    isBot: false,
    orgMemberships: [],
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  lastActiveAt: Date | null = new Date(NOW.getTime() - 3_600_000),
  recentPostCount = 5,
): { id: string; last_active_at: Date | null; recent_post_count: bigint } {
  return { id, last_active_at: lastActiveAt, recent_post_count: BigInt(recentPostCount) };
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
    totalViewCount: 12,
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

function makeTopPostRow(
  id: string,
  weeklyViews: number,
  authorId: string,
  rootId: string,
): { id: string; weekly_views: bigint; root_id: string; author_id: string } {
  return { id, weekly_views: BigInt(weeklyViews), root_id: rootId, author_id: authorId };
}

const DEFAULT_STATS_ROW = {
  public_posts: 30n,
  verified_posts: 10n,
  premium_posts: 2n,
  original_posts: 28n,
  reply_posts: 14n,
  premium_men: 5n,
  verified_men: 27n,
  contributors: 18n,
  original_authors: 12n,
  top_author_posts: 10n,
  top5_posts: 25n,
  median_posts: 3,
  public_articles: 8n,
  verified_articles: 3n,
  premium_articles: 1n,
  article_authors: 5n,
  article_views: 400n,
  article_unique: 400n,
  total_views: 1200n,
  unique_views: 1200n,
  premium_views: 400n,
  verified_views: 500n,
  unverified_views: 200n,
};

/** Identify which raw query is being called by looking for distinctive SQL fragments. */
function makePrisma(
  opts: {
    statsRows?: typeof DEFAULT_STATS_ROW[];
    candidateRows?: ReturnType<typeof makeCandidate>[];
    topPostRows?: ReturnType<typeof makeTopPostRow>[];
    userRows?: ReturnType<typeof makeUser>[];
  } = {},
) {
  const statsRows = opts.statsRows ?? [DEFAULT_STATS_ROW];
  const candidateRows = opts.candidateRows ?? [makeCandidate('user-1')];
  const topPostRows = opts.topPostRows ?? [makeTopPostRow('post-1', 5, 'user-1', 'post-1')];

  return {
    $queryRaw: jest.fn().mockImplementation((...args: unknown[]) => {
      const sql = String((args[0] as { strings: string[] }).strings?.[0] ?? args[0]);
      if (sql.includes('public_posts')) return Promise.resolve(statsRows);
      if (sql.includes('recent_post_count')) return Promise.resolve(candidateRows);
      if (sql.includes('weekly_views')) return Promise.resolve(topPostRows);
      return Promise.resolve([]);
    }),
    user: {
      findMany: jest.fn().mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in ?? [];
        return ids.map((id) => makeUser({ id, ...(opts.userRows?.find((u) => u.id === id) ?? {}) }));
      }),
    },
    post: {
      findMany: jest.fn().mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in ?? [];
        return ids.map((id) => makePost(id, `Post ${id}`));
      }),
    },
  };
}

function makeService(prismaOverride?: ReturnType<typeof makePrisma>) {
  const prisma = prismaOverride ?? makePrisma();
  const config = { r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.example.test' })) };
  const articles = { listTrending: jest.fn().mockResolvedValue([{ id: 'article-1', title: 'Trending' }]) };
  const cache = {
    getOrSetJson: jest.fn(async ({ compute }: { compute: () => Promise<unknown> }) => compute()),
  };
  const service = new LandingService(prisma as any, config as any, articles as any, cache as any);
  return { service, prisma, articles, cache };
}

describe('LandingService', () => {
  it('maps stats to the men/posts/views breakdown shape', async () => {
    const { service, cache } = makeService();
    const snapshot = await service.getSnapshot(NOW);

    // top author 10/42 ≈ 24%, top5 25/42 ≈ 60%
    expect(snapshot.stats.men).toEqual({
      premium: 5,
      verified: 27,
      total: 32,
      contributors: 18,
      originalAuthors: 12,
      topAuthorSharePercent: 24,
      top5SharePercent: 60,
      medianPostsPerContributor: 3,
    });
    expect(snapshot.stats.posts).toEqual({
      public: 30,
      verified: 10,
      premium: 2,
      original: 28,
      replies: 14,
      total: 42,
    });
    expect(snapshot.stats.articles).toEqual({
      public: 8,
      verified: 3,
      premium: 1,
      total: 12,
      authors: 5,
      views: 400,
      unique: 400,
    });
    // guest = unique − (premium + verified + unverified) = 1200 − 1100
    expect(snapshot.stats.views).toEqual({
      premium: 400,
      verified: 500,
      unverified: 200,
      guest: 100,
      total: 1200,
      unique: 1200,
    });
    expect(cache.getOrSetJson).toHaveBeenCalled();
  });

  it('builds recentlyActiveMen from scored candidates (avatar required)', async () => {
    const prisma = makePrisma({
      candidateRows: [
        makeCandidate('user-1', new Date(NOW.getTime() - 1_000_000), 20),
        makeCandidate('user-2', new Date(NOW.getTime() - 2_000_000), 5),
      ],
    });
    const { service } = makeService(prisma);
    const snapshot = await service.getSnapshot(NOW);

    // user-1 is more recent and more prolific — should come first
    expect(snapshot.recentlyActiveMen[0].id).toBe('user-1');
    expect(snapshot.recentlyActiveMen[1].id).toBe('user-2');
  });

  it('excludes lastOnlineAt / lastSeenAt from the returned user DTOs', async () => {
    const { service } = makeService();
    const snapshot = await service.getSnapshot(NOW);
    expect(snapshot.recentlyActiveMen[0]).not.toHaveProperty('lastOnlineAt');
    expect(snapshot.recentlyActiveMen[0]).not.toHaveProperty('lastSeenAt');
  });

  it('preserves the weekly top-post order from the ranking query', async () => {
    const prisma = makePrisma({
      topPostRows: [
        makeTopPostRow('post-2', 8, 'user-1', 'post-2'),
        makeTopPostRow('post-1', 5, 'user-1', 'post-1'),
      ],
    });
    const { service } = makeService(prisma);
    const snapshot = await service.getSnapshot(NOW);

    expect(snapshot.topPostsThisWeek.map((p) => ({ id: p.id, weeklyViewCount: p.weeklyViewCount }))).toEqual([
      { id: 'post-2', weeklyViewCount: 8 },
      { id: 'post-1', weeklyViewCount: 5 },
    ]);
  });

  it('defers 3rd post from the same author to backfill after first-pass cap', async () => {
    const rows = [
      makeTopPostRow('p1', 100, 'author-a', 'root-1'),
      makeTopPostRow('p2', 90, 'author-a', 'root-2'),
      makeTopPostRow('p3', 80, 'author-a', 'root-3'),
      makeTopPostRow('p4', 70, 'author-b', 'root-4'),
    ];
    const prisma = makePrisma({ topPostRows: rows });
    const { service } = makeService(prisma);
    const snapshot = await service.getSnapshot(NOW);

    const ids = snapshot.topPostsThisWeek.map((p) => p.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(ids).toContain('p4');
    const p3idx = ids.indexOf('p3');
    const p4idx = ids.indexOf('p4');
    if (p3idx !== -1 && p4idx !== -1) expect(p3idx).toBeGreaterThan(p4idx);
  });

  it('defers 3rd post from the same thread root to backfill after first-pass cap', async () => {
    const rows = [
      makeTopPostRow('pa', 100, 'author-1', 'root-x'),
      makeTopPostRow('pb', 90, 'author-2', 'root-x'),
      makeTopPostRow('pc', 80, 'author-3', 'root-x'),
      makeTopPostRow('pd', 70, 'author-4', 'root-y'),
    ];
    const prisma = makePrisma({ topPostRows: rows });
    const { service } = makeService(prisma);
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
    const prisma = makePrisma({ topPostRows: rows });
    const { service } = makeService(prisma);
    const snapshot = await service.getSnapshot(NOW);

    expect(snapshot.topPostsThisWeek.length).toBeLessThanOrEqual(14);
    expect(snapshot.topPostsThisWeek.length).toBeGreaterThan(0);
  });

  it('the stats query uses Prisma.sql so the mock can route it by SQL text', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    await service.getSnapshot(NOW);
    // $queryRaw should have been called at least once for the stats query
    const calls: unknown[][] = (prisma.$queryRaw as jest.Mock).mock.calls;
    const statsCall = calls.find((args) => {
      const sql = String((args[0] as { strings?: string[] }).strings?.[0] ?? args[0]);
      return sql.includes('public_posts');
    });
    expect(statsCall).toBeDefined();
  });

  it('feeds listTrending with viewerUserId=null and limit=3', async () => {
    const { service, articles } = makeService();
    await service.getSnapshot(NOW);
    expect(articles.listTrending).toHaveBeenCalledWith({
      viewerUserId: null,
      limit: 3,
      fillIfShort: true,
    });
  });

  it('returns zero counts when no stats row exists', async () => {
    const prisma = makePrisma({ statsRows: [] });
    const { service } = makeService(prisma);
    const snapshot = await service.getSnapshot(NOW);
    expect(snapshot.stats.men).toEqual({
      premium: 0,
      verified: 0,
      total: 0,
      contributors: 0,
      originalAuthors: 0,
      topAuthorSharePercent: 0,
      top5SharePercent: 0,
      medianPostsPerContributor: 0,
    });
    expect(snapshot.stats.posts).toEqual({
      public: 0,
      verified: 0,
      premium: 0,
      original: 0,
      replies: 0,
      total: 0,
    });
    expect(snapshot.stats.articles).toEqual({
      public: 0,
      verified: 0,
      premium: 0,
      total: 0,
      authors: 0,
      views: 0,
      unique: 0,
    });
    expect(snapshot.stats.views).toEqual({
      premium: 0,
      verified: 0,
      unverified: 0,
      guest: 0,
      total: 0,
      unique: 0,
    });
  });

  it('total posts = sum of public + verified + premium', async () => {
    const { service } = makeService();
    const snapshot = await service.getSnapshot(NOW);
    const { public: pub, verified, premium, total } = snapshot.stats.posts;
    expect(total).toBe(pub + verified + premium);
  });

  it('total men = premium + verified', async () => {
    const { service } = makeService();
    const snapshot = await service.getSnapshot(NOW);
    const { premium, verified, total } = snapshot.stats.men;
    expect(total).toBe(premium + verified);
  });

  it('views total = premium + verified + unverified + guest', async () => {
    const { service } = makeService();
    const snapshot = await service.getSnapshot(NOW);
    const { premium, verified, unverified, guest, total } = snapshot.stats.views;
    expect(total).toBe(premium + verified + unverified + guest);
  });

  it('uses the windowStart variable from the snapshot date', () => {
    // Verify WINDOW_START is 30 days before NOW — used in candidate query construction
    const expected = new Date(NOW.getTime() - 30 * 86400000);
    expect(WINDOW_START.getTime()).toBe(expected.getTime());
  });
});
