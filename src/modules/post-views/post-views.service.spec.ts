import { PostViewsService } from './post-views.service';

describe('PostViewsService.markViewed', () => {
  function makeService(opts?: { createdCount?: number; impressionCount?: number; lastSeenCount?: number }) {
    const createdCount = opts?.createdCount ?? 0;
    const impressionCount = opts?.impressionCount ?? 0;
    const lastSeenCount = opts?.lastSeenCount ?? 1;
    const tx = {
      postView: {
        createMany: jest.fn(async () => ({ count: createdCount })),
        updateMany: jest.fn(async (args: { where?: { lastImpressionAt?: unknown; lastSeenAt?: unknown } }) => {
          if (args?.where?.lastImpressionAt) return { count: impressionCount };
          if (args?.where?.lastSeenAt) return { count: lastSeenCount };
          return { count: 0 };
        }),
      },
      postAnonView: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      post: {
        update: jest.fn(async () => ({ viewerCount: 12, totalViewCount: 13 })),
        findUnique: jest.fn(async () => ({ viewerCount: 12, totalViewCount: 12 })),
      },
    };
    const prisma = {
      post: {
        findFirst: jest.fn(async () => ({ id: 'p1', visibility: 'public', userId: 'author' })),
        update: jest.fn(async () => ({ viewerCount: 12, totalViewCount: 13 })),
        findUnique: jest.fn(async () => ({ viewerCount: 12, totalViewCount: 12 })),
      },
      user: {
        findFirst: jest.fn(async () => ({
          isBot: false,
          verifiedStatus: 'identity',
          premium: false,
          premiumPlus: false,
        })),
      },
      viewerIdentity: {
        upsert: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => null),
      },
      postView: {
        findUnique: jest.fn(async () => null),
      },
      postAnonView: {
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const cache = {};
    const redis = {
      del: jest.fn(async () => undefined),
      setString: jest.fn(async () => true),
    };
    const cacheInvalidation = { bumpForYouUser: jest.fn(async () => 2) };
    const presenceRealtime = {
      emitPostsLiveUpdated: jest.fn(),
      emitPostsLiveUpdatedToUser: jest.fn(),
    };
    const posthog = { capture: jest.fn() };
    const notifications = {
      markReadBySubject: jest.fn(async () => undefined),
      markReadBySubjects: jest.fn(async () => undefined),
    };
    const service = new PostViewsService(
      prisma as any,
      cache as any,
      redis as any,
      cacheInvalidation as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any,
    );
    return { service, prisma, tx, redis, cacheInvalidation, presenceRealtime, posthog, notifications };
  }

  it('updates repeat authenticated views without incrementing unique viewer count', async () => {
    const { service, tx, redis, cacheInvalidation, presenceRealtime, posthog, notifications } = makeService({
      createdCount: 0,
      impressionCount: 0,
    });

    const ack = await service.markViewed('viewer', 'p1', null, 'feed_scroll');

    expect(ack).toEqual({
      id: 'p1',
      uniqueCounted: false,
      totalCounted: false,
      viewerCount: 12,
      totalViewCount: 12,
    });
    expect(tx.postView.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ postId: 'p1', userId: 'viewer', seenCount: 1, lastSource: 'feed_scroll' })],
      skipDuplicates: true,
    });
    expect(tx.postView.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        postId: 'p1',
        userId: 'viewer',
        lastSeenAt: { lt: expect.any(Date) },
      }),
      data: expect.objectContaining({
        lastSeenAt: expect.any(Date),
        seenCount: { increment: 1 },
        lastSource: 'feed_scroll',
      }),
    });
    expect(tx.post.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(cacheInvalidation.bumpForYouUser).toHaveBeenCalledWith('viewer');
    expect(presenceRealtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(notifications.markReadBySubject).toHaveBeenCalledWith('viewer', { postId: 'p1' });
  });

  it('increments total (not unique) when lastImpressionAt is older than 30s', async () => {
    const { service, tx, presenceRealtime, redis } = makeService({
      createdCount: 0,
      impressionCount: 1,
    });

    const ack = await service.markViewed('viewer', 'p1', null, 'feed_scroll');

    expect(ack).toEqual({
      id: 'p1',
      uniqueCounted: false,
      totalCounted: true,
      viewerCount: 12,
      totalViewCount: 13,
    });
    expect(tx.post.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { totalViewCount: { increment: 1 } },
      select: { viewerCount: true, totalViewCount: true },
    });
    expect(presenceRealtime.emitPostsLiveUpdatedToUser).toHaveBeenCalled();
    expect(redis.setString).toHaveBeenCalledWith(
      'view-emit:post:p1',
      '1',
      expect.objectContaining({ onlyIfAbsent: true }),
    );
    expect(presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        patch: { viewerCount: 12, totalViewCount: 13 },
      }),
    );
  });

  it('bumps unique and total on the first authenticated view', async () => {
    const { service, tx, cacheInvalidation, presenceRealtime, posthog } = makeService({ createdCount: 1 });

    const ack = await service.markViewed('viewer', 'p1', null, 'feed_scroll');

    expect(ack?.uniqueCounted).toBe(true);
    expect(ack?.totalCounted).toBe(true);
    expect(tx.post.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({
        viewerCount: { increment: 1 },
        totalViewCount: { increment: 1 },
      }),
      select: { viewerCount: true, totalViewCount: true },
    });
    expect(cacheInvalidation.bumpForYouUser).toHaveBeenCalledWith('viewer');
    expect(presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalled();
  });

  it('bumps unique and total on the first anonymous view', async () => {
    const { service, prisma, redis, presenceRealtime } = makeService();
    prisma.postAnonView.createMany = jest.fn(async () => ({ count: 1 }));

    const ack = await service.markViewed(null, 'p1', 'anon_guestviewer1', 'permalink_engaged');

    expect(ack).toEqual({
      id: 'p1',
      uniqueCounted: true,
      totalCounted: true,
      viewerCount: 12,
      totalViewCount: 13,
    });
    expect(prisma.postAnonView.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ postId: 'p1', anonId: 'anon_guestviewer1', impressionCount: 1 })],
      skipDuplicates: true,
    });
    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({
        viewerCount: { increment: 1 },
        totalViewCount: { increment: 1 },
      }),
      select: { viewerCount: true, totalViewCount: true },
    });
    expect(presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        patch: { viewerCount: 12, totalViewCount: 13 },
      }),
    );
    expect(redis.del).toHaveBeenCalled();
  });

  it('does not count an anonymous view without an anon id', async () => {
    const { service, prisma } = makeService();

    expect(await service.markViewed(null, 'p1', null, 'permalink_engaged')).toBeNull();
    expect(prisma.postAnonView.createMany).not.toHaveBeenCalled();
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('does not bump For You when a repeat view is still inside the last-seen buffer', async () => {
    const { service, cacheInvalidation } = makeService({
      createdCount: 0,
      lastSeenCount: 0,
      impressionCount: 0,
    });

    await service.markViewed('viewer', 'p1', null, 'feed_scroll');

    expect(cacheInvalidation.bumpForYouUser).not.toHaveBeenCalled();
  });
});

describe('PostViewsService.markViewedBatch', () => {
  function makeBatchService() {
    const findMany = jest.fn(async (): Promise<
      Array<{ id: string; kind: string; repostedPostId: string | null; quotedPostId: string | null }>
    > => []);
    const prisma = {
      post: {
        findMany,
        findFirst: jest.fn(async () => ({ id: 'p1', visibility: 'public', userId: 'author' })),
        update: jest.fn(async () => ({ viewerCount: 1, totalViewCount: 1 })),
      },
      user: {
        findFirst: jest.fn(async () => ({
          isBot: false,
          verifiedStatus: 'identity',
          premium: false,
          premiumPlus: false,
        })),
      },
      viewerIdentity: {
        upsert: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => null),
      },
      postView: {
        findUnique: jest.fn(async () => null),
      },
      postAnonView: {
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (fn: any) =>
        fn({
          postView: {
            createMany: jest.fn(async () => ({ count: 1 })),
            update: jest.fn(async () => ({})),
          },
          postAnonView: { deleteMany: jest.fn(async () => ({ count: 0 })) },
          post: { update: jest.fn(async () => ({ viewerCount: 1, totalViewCount: 1 })) },
        }),
      ),
    };
    const cache = {};
    const redis = { del: jest.fn(async () => undefined), setString: jest.fn(async () => true) };
    const cacheInvalidation = { bumpForYouUser: jest.fn(async () => 2) };
    const presenceRealtime = { emitPostsLiveUpdated: jest.fn(), emitPostsLiveUpdatedToUser: jest.fn() };
    const posthog = { capture: jest.fn() };
    const notifications = {
      markReadBySubject: jest.fn(async () => undefined),
      markReadBySubjects: jest.fn(async () => undefined),
    };
    const service = new PostViewsService(
      prisma as any,
      cache as any,
      redis as any,
      cacheInvalidation as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any,
    );
    return { service, prisma, findMany, notifications };
  }

  it('expands flat repost and quoted post IDs into the batch', async () => {
    const { service, prisma, findMany, notifications } = makeBatchService();
    findMany.mockResolvedValueOnce([
      { id: 'repost-shell', kind: 'repost', repostedPostId: 'original', quotedPostId: null },
      { id: 'quote-post', kind: 'post', repostedPostId: null, quotedPostId: 'quoted' },
    ]);

    const markViewed = jest.spyOn(service, 'markViewed').mockResolvedValue({
      id: 'p',
      uniqueCounted: false,
      totalCounted: false,
      viewerCount: 1,
      totalViewCount: 1,
    });

    await service.markViewedBatch('viewer', ['repost-shell', 'quote-post'], null, 'feed_scroll');

    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['repost-shell', 'quote-post'] }, deletedAt: null },
      select: { id: true, kind: true, repostedPostId: true, quotedPostId: true },
    });
    const marked = markViewed.mock.calls.map((c) => c[1]).sort();
    expect(marked).toEqual(['original', 'quote-post', 'quoted', 'repost-shell']);
    for (const call of markViewed.mock.calls) {
      expect(call[4]).toEqual({ skipMarkRead: true });
    }
    expect(notifications.markReadBySubjects).toHaveBeenCalledTimes(1);
    expect(notifications.markReadBySubjects).toHaveBeenCalledWith(
      'viewer',
      expect.arrayContaining(['original', 'quote-post', 'quoted', 'repost-shell']),
    );
    expect(notifications.markReadBySubject).not.toHaveBeenCalled();
  });

  it('does not expand non-repost posts without quotedPostId', async () => {
    const { service, findMany, notifications } = makeBatchService();
    findMany.mockResolvedValueOnce([
      { id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null },
    ]);

    const markViewed = jest.spyOn(service, 'markViewed').mockResolvedValue({
      id: 'plain',
      uniqueCounted: true,
      totalCounted: true,
      viewerCount: 1,
      totalViewCount: 1,
    });

    await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');

    expect(markViewed).toHaveBeenCalledTimes(1);
    expect(markViewed).toHaveBeenCalledWith('viewer', 'plain', null, 'feed_scroll', { skipMarkRead: true });
    expect(notifications.markReadBySubjects).toHaveBeenCalledWith('viewer', ['plain']);
  });
});
