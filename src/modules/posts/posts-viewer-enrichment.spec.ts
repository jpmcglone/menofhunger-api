import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';

function makeService(postViewRows: Array<{ postId: string; lastSeenAt?: Date; createdAt?: Date }> = []) {
  const prisma: any = {
    postView: {
      findMany: jest.fn(async () => postViewRows),
    },
    boost: { findMany: jest.fn(async () => []) },
    bookmark: { findMany: jest.fn(async () => []) },
    postPollVote: { findMany: jest.fn(async () => []) },
    post: { findMany: jest.fn(async () => []) },
    userBlock: { findMany: jest.fn(async () => []) },
  };

  const requestCache: any = {
    _store: new Map<string, unknown>(),
    get(key: string) {
      return this._store.get(key) ?? null;
    },
    set(key: string, value: unknown) {
      this._store.set(key, value);
    },
  };

  const viewerContextService: any = {
    getViewer: jest.fn(async () => null),
    allowedPostVisibilities: jest.fn(() => []),
  };

  const redis: any = {
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  };

  const service = new PostsViewerEnrichmentService(
    prisma,
    requestCache,
    viewerContextService,
    redis,
  );

  return { service, prisma, requestCache };
}

describe('PostsViewerEnrichmentService.viewerViewedPostIds', () => {
  it('returns empty set when no viewerUserId', async () => {
    const { service } = makeService();
    const result = await service.viewerViewedPostIds({ viewerUserId: '', postIds: ['p1'] });
    expect(result.size).toBe(0);
  });

  it('returns empty set when no postIds', async () => {
    const { service } = makeService();
    const result = await service.viewerViewedPostIds({ viewerUserId: 'u1', postIds: [] });
    expect(result.size).toBe(0);
  });

  it('returns only the post IDs the viewer has viewed', async () => {
    const { service } = makeService([{ postId: 'p1' }, { postId: 'p3' }]);
    const result = await service.viewerViewedPostIds({
      viewerUserId: 'u1',
      postIds: ['p1', 'p2', 'p3'],
    });
    expect([...result].sort()).toEqual(['p1', 'p3']);
  });

  it('returns empty set when viewer has viewed none of the requested posts', async () => {
    const { service } = makeService([]);
    const result = await service.viewerViewedPostIds({
      viewerUserId: 'u1',
      postIds: ['p1', 'p2'],
    });
    expect(result.size).toBe(0);
  });

  it('uses request-cache to avoid duplicate DB queries within the same request', async () => {
    const { service, prisma } = makeService([{ postId: 'p1' }]);
    await service.viewerViewedPostIds({ viewerUserId: 'u1', postIds: ['p1'] });
    await service.viewerViewedPostIds({ viewerUserId: 'u1', postIds: ['p1'] });
    expect(prisma.postView.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('PostsViewerEnrichmentService.viewerLastSeenAtByPostId', () => {
  it('returns lastSeenAt (falling back to createdAt) for viewed posts', async () => {
    const seen = new Date('2026-08-01T12:00:00.000Z');
    const created = new Date('2026-07-01T12:00:00.000Z');
    const { service } = makeService([
      { postId: 'p1', lastSeenAt: seen, createdAt: created },
      { postId: 'p2', lastSeenAt: null as unknown as Date, createdAt: created },
    ]);
    const result = await service.viewerLastSeenAtByPostId({
      viewerUserId: 'u1',
      postIds: ['p1', 'p2', 'p3'],
    });
    expect(result.get('p1')?.toISOString()).toBe(seen.toISOString());
    expect(result.get('p2')?.toISOString()).toBe(created.toISOString());
    expect(result.has('p3')).toBe(false);
  });

  it('shares the viewed request-cache with viewerViewedPostIds', async () => {
    const { service, prisma } = makeService([{ postId: 'p1', lastSeenAt: new Date() }]);
    await service.viewerViewedPostIds({ viewerUserId: 'u1', postIds: ['p1'] });
    await service.viewerLastSeenAtByPostId({ viewerUserId: 'u1', postIds: ['p1'] });
    expect(prisma.postView.findMany).toHaveBeenCalledTimes(1);
  });
});
