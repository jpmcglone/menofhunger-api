import { ArticleViewsService } from './article-views.service';

describe('ArticleViewsService', () => {
  function makeService() {
    const prisma = {
      articleView: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      article: {
        findFirst: jest.fn().mockResolvedValue({
          visibility: 'public',
          authorId: 'author-1',
          viewCount: 10,
          totalViewCount: 21,
        }),
      },
      user: { findFirst: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          premium: 1n,
          verified: 2n,
          unverified: 3n,
          premium_total: 4n,
          verified_total: 5n,
          unverified_total: 6n,
        },
      ]),
    };
    const cache = {
      getOrSetJson: jest.fn(async (params: { compute: () => Promise<unknown> }) => params.compute()),
    };
    const service = new ArticleViewsService(
      prisma as any,
      cache as any,
      { del: jest.fn() } as any,
      { emitArticlesLiveUpdated: jest.fn() } as any,
      { markReadBySubject: jest.fn() } as any,
    );
    return { service, prisma, cache };
  }

  it('viewerViewedArticleIds returns empty for guests and empty id lists', async () => {
    const { service, prisma } = makeService();
    await expect(service.viewerViewedArticleIds(null, ['a1'])).resolves.toEqual(new Set());
    await expect(service.viewerViewedArticleIds('u1', [])).resolves.toEqual(new Set());
    expect(prisma.articleView.findMany).not.toHaveBeenCalled();
  });

  it('viewerViewedArticleIds returns the viewed id set', async () => {
    const { service, prisma } = makeService();
    prisma.articleView.findMany.mockResolvedValue([{ articleId: 'a1' }, { articleId: 'a3' }]);
    await expect(service.viewerViewedArticleIds('u1', ['a1', 'a2', 'a3'])).resolves.toEqual(
      new Set(['a1', 'a3']),
    );
    expect(prisma.articleView.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', articleId: { in: ['a1', 'a2', 'a3'] } },
      select: { articleId: true },
    });
  });

  it('getBreakdown skips the cache when fresh is set', async () => {
    const { service, cache } = makeService();
    const result = await service.getBreakdown('article-1', null, { fresh: true });
    expect(cache.getOrSetJson).not.toHaveBeenCalled();
    expect(result.total).toBe(10);
    expect(result.totalViewCount).toBe(21);
    expect(result.premium).toBe(1);
    expect(result.guest).toBe(4);
    expect(result.guestTotal).toBe(6);
  });

  it('getBreakdown uses the cache when fresh is not set', async () => {
    const { service, cache } = makeService();
    await service.getBreakdown('article-1', null);
    expect(cache.getOrSetJson).toHaveBeenCalledTimes(1);
  });
});
