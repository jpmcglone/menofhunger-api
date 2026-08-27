import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { VerifiedStatus } from '@prisma/client';
import { ArticlesService } from './articles.service';

function makeService(opts?: { allowedVisibilities?: Array<'public' | 'verifiedOnly' | 'premiumOnly'> }) {
  const prisma = {
    article: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as any;

  const viewer = {
    getViewer: jest.fn().mockResolvedValue({
      id: 'viewer-1',
      verifiedStatus: VerifiedStatus.identity,
      premium: false,
      premiumPlus: false,
      siteAdmin: false,
    }),
    allowedPostVisibilities: jest.fn().mockReturnValue(opts?.allowedVisibilities ?? ['public']),
  } as any;

  const appConfig = {
    r2: jest.fn().mockReturnValue({ publicBaseUrl: 'https://cdn.example.com' }),
  } as any;

  const cache = { getOrSetJson: jest.fn(async (_params: any) => _params.compute()) } as any;
  const cacheInvalidation = { feedGlobalVersion: jest.fn(async () => 1) } as any;

  const service = new ArticlesService(
    prisma,
    viewer,
    appConfig,
    {} as any,
    cache,
    cacheInvalidation,
    { enqueue: jest.fn().mockResolvedValue({}) } as any,
    { dispatch: jest.fn() } as any,
    { viewerViewedArticleIds: jest.fn().mockResolvedValue(new Set()) } as any,
  );

  return { service, prisma, viewer };
}

type TierOpts = {
  isVerified?: boolean;
  isPremium?: boolean;
};

function makeAuthoringService(tier: TierOpts = {}) {
  const isVerified = tier.isVerified ?? false;
  const isPremium = tier.isPremium ?? false;

  const verifiedStatus = isVerified ? VerifiedStatus.identity : VerifiedStatus.none;
  const allowedVisibilities: Array<'public' | 'verifiedOnly' | 'premiumOnly'> = ['public'];
  if (isVerified || isPremium) allowedVisibilities.push('verifiedOnly');
  if (isPremium) allowedVisibilities.push('premiumOnly');

  const viewerCtx = {
    id: 'user-1',
    verifiedStatus,
    premium: isPremium,
    premiumPlus: false,
    siteAdmin: false,
    bannedAt: null,
    isBot: false,
  };

  const createdArticle = {
    id: 'article-1',
    authorId: 'user-1',
    title: 'Test article',
    slug: 'test-article',
    body: null,
    excerpt: null,
    thumbnailR2Key: null,
    visibility: 'public',
    isDraft: true,
    publishedAt: null,
    editedAt: null,
    deletedAt: null,
    lastSavedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    viewCount: 0,
    weightedViewCount: 0,
    author: {
      id: 'user-1',
      username: 'testuser',
      name: 'Test User',
      avatarR2Key: null,
      verifiedStatus,
      premium: isPremium,
      premiumPlus: false,
    },
    tags: [],
    boosts: [],
    reactions: [],
    _count: { comments: 0 },
  };

  const prisma = {
    article: {
      create: jest.fn().mockResolvedValue(createdArticle),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ ...createdArticle, isDraft: false }),
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prisma)),
    },
    articleView: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    articleTag: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((fn: any) =>
      fn({
        article: prisma.article,
        articleView: prisma.articleView,
        articleTag: prisma.articleTag,
      }),
    ),
  } as any;

  const viewer = {
    getViewerOrThrow: jest.fn().mockResolvedValue(viewerCtx),
    getViewer: jest.fn().mockResolvedValue(viewerCtx),
    isVerified: jest.fn().mockReturnValue(isVerified),
    isPremium: jest.fn().mockReturnValue(isPremium),
    allowedPostVisibilities: jest.fn().mockReturnValue(allowedVisibilities),
  } as any;

  const appConfig = {
    r2: jest.fn().mockReturnValue({ publicBaseUrl: 'https://cdn.example.com' }),
    frontendBaseUrl: jest.fn().mockReturnValue('https://menofhunger.com'),
  } as any;

  const cacheInvalidation = {
    feedGlobalVersion: jest.fn().mockResolvedValue(1),
    bumpFeedGlobal: jest.fn().mockResolvedValue(undefined),
  } as any;

  const service = new ArticlesService(
    prisma,
    viewer,
    appConfig,
    {} as any,
    { getOrSetJson: jest.fn(async (_p: any) => _p.compute()) } as any,
    cacheInvalidation,
    { enqueue: jest.fn().mockResolvedValue({}) } as any,
    { dispatch: jest.fn() } as any,
    { viewerViewedArticleIds: jest.fn().mockResolvedValue(new Set()) } as any,
  );

  return { service, prisma, viewer };
}

describe('ArticlesService.listPublished visibility filters', () => {
  it('rejects unauthorized verifiedOnly explicit filter when includeRestricted is false', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public'] });

    await expect(
      service.listPublished({
        viewerUserId: 'viewer-1',
        visibilityFilter: 'verifiedOnly',
        includeRestricted: false,
      }),
    ).rejects.toThrow(new ForbiddenException('Verify to view verified-only posts.'));

    expect(prisma.article.findMany).not.toHaveBeenCalled();
  });

  it('rejects unauthorized premiumOnly explicit filter when includeRestricted is false', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public', 'verifiedOnly'] });

    await expect(
      service.listPublished({
        viewerUserId: 'viewer-1',
        visibilityFilter: 'premiumOnly',
        includeRestricted: false,
      }),
    ).rejects.toThrow(new ForbiddenException('Upgrade to premium to view premium-only posts.'));

    expect(prisma.article.findMany).not.toHaveBeenCalled();
  });

  it('honors explicit visibility filter in restricted-preview mode', async () => {
    const { service, prisma } = makeService({ allowedVisibilities: ['public', 'verifiedOnly'] });

    await service.listPublished({
      viewerUserId: 'viewer-1',
      visibilityFilter: 'premiumOnly',
      includeRestricted: true,
    });

    expect(prisma.article.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.article.findMany.mock.calls[0]?.[0] ?? {};
    expect(call.where?.visibility).toBe('premiumOnly');
  });
});

describe('ArticlesService.create tier gates', () => {
  it('allows a verified user to create an article', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true });
    prisma.article.findFirst.mockResolvedValue(null);
    await expect(service.create('user-1', {})).resolves.toBeDefined();
  });

  it('rejects an unverified non-premium user', async () => {
    const { service } = makeAuthoringService({ isVerified: false, isPremium: false });
    await expect(service.create('user-1', {})).rejects.toThrow(
      new ForbiddenException('Verify your account to create articles.'),
    );
  });

  it('rejects a verified user trying to set premiumOnly visibility', async () => {
    const { service } = makeAuthoringService({ isVerified: true, isPremium: false });
    await expect(service.create('user-1', { visibility: 'premiumOnly' })).rejects.toThrow(
      new ForbiddenException('Upgrade to premium to create premium-only articles.'),
    );
  });

  it('allows a premium user to set premiumOnly visibility', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: true });
    prisma.article.findFirst.mockResolvedValue(null);
    const result = await service.create('user-1', { visibility: 'premiumOnly' });
    expect(result).toBeDefined();
  });
});

describe('ArticlesService.save visibility gate', () => {
  it('rejects a verified user trying to save with premiumOnly visibility', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: false });
    prisma.article.findUnique.mockResolvedValue({
      id: 'article-1',
      authorId: 'user-1',
      deletedAt: null,
      title: 'Draft',
      slug: 'draft',
      body: null,
      excerpt: null,
      thumbnailR2Key: null,
      visibility: 'public',
      isDraft: true,
      publishedAt: null,
    });
    await expect(service.save('user-1', 'article-1', { visibility: 'premiumOnly' })).rejects.toThrow(
      new ForbiddenException('Upgrade to premium to create premium-only articles.'),
    );
  });

  it('allows a verified user to save with verifiedOnly visibility', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: false });
    const now = new Date();
    const articleRow = {
      id: 'article-1',
      authorId: 'user-1',
      deletedAt: null,
      title: 'Draft',
      slug: 'draft',
      body: null,
      excerpt: null,
      thumbnailR2Key: null,
      visibility: 'public',
      isDraft: true,
      publishedAt: null,
      editedAt: null,
      lastSavedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    prisma.article.findUnique.mockResolvedValue(articleRow);
    prisma.article.update.mockResolvedValue({
      ...articleRow,
      visibility: 'verifiedOnly',
      author: { id: 'user-1', username: 'u', name: 'U', avatarR2Key: null, verifiedStatus: VerifiedStatus.identity, premium: false, premiumPlus: false },
      tags: [],
      boosts: [],
      reactions: [],
      _count: { comments: 0 },
    });
    await expect(service.save('user-1', 'article-1', { visibility: 'verifiedOnly' })).resolves.toBeDefined();
  });
});

describe('ArticlesService.publish tier gates and daily limit', () => {
  function makePublishableArticle(overrides: Record<string, unknown> = {}) {
    return {
      id: 'article-1',
      authorId: 'user-1',
      title: 'My Article',
      slug: 'my-article',
      body: '<p>Content</p>',
      excerpt: 'Content',
      thumbnailR2Key: null,
      visibility: 'public',
      isDraft: true,
      publishedAt: null,
      editedAt: null,
      deletedAt: null,
      lastSavedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      viewCount: 0,
      weightedViewCount: 0,
      author: {
        id: 'user-1',
        username: 'testuser',
        name: 'Test User',
        avatarR2Key: null,
        verifiedStatus: VerifiedStatus.identity,
        premium: false,
        premiumPlus: false,
      },
      tags: [],
      boosts: [],
      reactions: [],
      _count: { comments: 0 },
      ...overrides,
    };
  }

  it('rejects an unverified non-premium user', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: false, isPremium: false });
    prisma.article.findUnique.mockResolvedValue(makePublishableArticle());
    await expect(service.publish('user-1', 'article-1')).rejects.toThrow(
      new ForbiddenException('Verify your account to publish articles.'),
    );
  });

  it('allows a verified user to publish their first article today', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true });
    prisma.article.findUnique.mockResolvedValue(makePublishableArticle());
    prisma.article.findMany.mockResolvedValue([]); // no other publishes today
    prisma.article.update.mockResolvedValue(makePublishableArticle({ isDraft: false, publishedAt: new Date() }));
    prisma.articleView.createMany.mockResolvedValue({ count: 1 });
    prisma.article.update.mockResolvedValueOnce(makePublishableArticle({ isDraft: false, publishedAt: new Date(), viewCount: 1, weightedViewCount: 1 }));
    await expect(service.publish('user-1', 'article-1')).resolves.toBeDefined();
  });

  it('blocks a verified non-premium user from publishing a second article on the same ET day', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: false });
    prisma.article.findUnique.mockResolvedValue(makePublishableArticle());
    // Simulate one article already published today
    const todayPublishedAt = new Date();
    prisma.article.findMany.mockResolvedValue([{ publishedAt: todayPublishedAt }]);
    await expect(service.publish('user-1', 'article-1')).rejects.toThrow(
      new HttpException(
        'You can publish 1 article per day. Upgrade to Premium for unlimited.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
  });

  it('does not count republish (publishedAt already set) against the daily limit', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: false });
    const alreadyPublishedArticle = makePublishableArticle({ isDraft: false, publishedAt: new Date(Date.now() - 1000) });
    prisma.article.findUnique.mockResolvedValue(alreadyPublishedArticle);
    prisma.article.update.mockResolvedValue(alreadyPublishedArticle);
    // Even if there's a prior publish today, republishing should not trigger the limit
    prisma.article.findMany.mockResolvedValue([{ publishedAt: new Date() }]);
    await expect(service.publish('user-1', 'article-1')).resolves.toBeDefined();
  });

  it('allows a premium user to publish multiple articles on the same day', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: true });
    prisma.article.findUnique.mockResolvedValue(makePublishableArticle());
    // Would block a verified user, but not premium
    prisma.article.findMany.mockResolvedValue([{ publishedAt: new Date() }, { publishedAt: new Date() }]);
    prisma.article.update.mockResolvedValue(makePublishableArticle({ isDraft: false, publishedAt: new Date() }));
    prisma.articleView.createMany.mockResolvedValue({ count: 1 });
    await expect(service.publish('user-1', 'article-1')).resolves.toBeDefined();
  });

  it('rejects a verified non-premium user trying to publish a premiumOnly article', async () => {
    const { service, prisma } = makeAuthoringService({ isVerified: true, isPremium: false });
    prisma.article.findUnique.mockResolvedValue(makePublishableArticle({ visibility: 'premiumOnly' }));
    await expect(service.publish('user-1', 'article-1')).rejects.toThrow(ForbiddenException);
  });
});

describe('ArticlesService.listTrending', () => {
  function trendingRow(id: string) {
    const now = new Date();
    return {
      id,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
      editedAt: null,
      deletedAt: null,
      title: id,
      slug: id,
      body: '{}',
      excerpt: null,
      thumbnailR2Key: null,
      visibility: 'public',
      isDraft: false,
      lastSavedAt: now,
      boostCount: 0,
      commentCount: 0,
      viewCount: 0,
      author: {
        id: 'author-1',
        username: 'peter',
        name: 'Peter',
        bio: null,
        articleBio: null,
        avatarKey: null,
        avatarUpdatedAt: null,
        verifiedStatus: VerifiedStatus.none,
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        orgMemberships: [],
      },
      tags: [],
      boosts: [],
      reactions: [],
    };
  }

  it('stays inside the 7-day scored window unless fillIfShort is set', async () => {
    const { service, prisma } = makeService();
    prisma.article.findMany.mockResolvedValueOnce([trendingRow('a1'), trendingRow('a2')]);

    const result = await service.listTrending({ viewerUserId: null, limit: 3 });

    expect(result.map((article) => article.id)).toEqual(['a1', 'a2']);
    expect(prisma.article.findMany).toHaveBeenCalledTimes(1);
  });

  it('backfills older published articles when the weekly set is short', async () => {
    const { service, prisma } = makeService();
    prisma.article.findMany
      .mockResolvedValueOnce([trendingRow('a1'), trendingRow('a2')])
      .mockResolvedValueOnce([trendingRow('a3')]);

    const result = await service.listTrending({
      viewerUserId: null,
      limit: 3,
      fillIfShort: true,
    });

    expect(result.map((article) => article.id)).toEqual(['a1', 'a2', 'a3']);
    expect(prisma.article.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.article.findMany.mock.calls[1][0].where.id).toEqual({ notIn: ['a1', 'a2'] });
  });

  it('omits TipTap body by default and keeps it when includeBody is true', async () => {
    const { service, prisma } = makeService();
    const row = { ...trendingRow('a1'), body: JSON.stringify({ type: 'doc', content: [] }), excerpt: 'Hello' };
    prisma.article.findMany.mockResolvedValueOnce([row]);

    const listed = await service.listTrending({ viewerUserId: null, limit: 1 });
    expect(listed[0]?.body).toBe('{}');
    expect(listed[0]?.excerpt).toBe('Hello');

    prisma.article.findMany.mockResolvedValueOnce([row]);
    const full = await service.listTrending({ viewerUserId: null, limit: 1, includeBody: true });
    expect(full[0]?.body).toBe(row.body);
  });
});
