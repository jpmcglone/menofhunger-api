import { PostViewsService } from './post-views.service';

describe('PostViewsService.markViewed', () => {
  function makeService(opts?: { createdCount?: number }) {
    const createdCount = opts?.createdCount ?? 0;
    const tx = {
      postView: {
        createMany: jest.fn(async () => ({ count: createdCount })),
        update: jest.fn(async () => ({})),
      },
      postAnonView: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      post: {
        update: jest.fn(async () => ({ viewerCount: 12 })),
        findUnique: jest.fn(async () => ({ viewerCount: 12 })),
      },
    };
    const prisma = {
      post: {
        findFirst: jest.fn(async () => ({ id: 'p1', visibility: 'public', userId: 'author' })),
        update: jest.fn(async () => ({ viewerCount: 12 })),
      },
      user: {
        findFirst: jest.fn(async () => ({ verifiedStatus: 'identity', premium: false, premiumPlus: false })),
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
    const redis = { del: jest.fn(async () => undefined) };
    const presenceRealtime = { emitPostsLiveUpdated: jest.fn() };
    const posthog = { capture: jest.fn() };
    const notifications = { markReadBySubject: jest.fn(async () => undefined) };
    const service = new PostViewsService(
      prisma as any,
      cache as any,
      redis as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any,
    );
    return { service, prisma, tx, redis, presenceRealtime, posthog, notifications };
  }

  it('updates repeat authenticated views without incrementing unique viewer count', async () => {
    const { service, tx, redis, presenceRealtime, posthog, notifications } = makeService({ createdCount: 0 });

    await service.markViewed('viewer', 'p1', null, 'feed_scroll');

    expect(tx.postView.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ postId: 'p1', userId: 'viewer', seenCount: 1, lastSource: 'feed_scroll' })],
      skipDuplicates: true,
    });
    expect(tx.postView.update).toHaveBeenCalledWith({
      where: { postId_userId: { postId: 'p1', userId: 'viewer' } },
      data: expect.objectContaining({
        seenCount: { increment: 1 },
        lastSource: 'feed_scroll',
      }),
    });
    expect(tx.post.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(presenceRealtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(notifications.markReadBySubject).toHaveBeenCalledWith('viewer', { postId: 'p1' });
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
        update: jest.fn(async () => ({ viewerCount: 1 })),
      },
      user: {
        findFirst: jest.fn(async () => ({ verifiedStatus: 'identity', premium: false, premiumPlus: false })),
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
          post: { update: jest.fn(async () => ({ viewerCount: 1 })) },
        }),
      ),
    };
    const cache = {};
    const redis = { del: jest.fn(async () => undefined) };
    const presenceRealtime = { emitPostsLiveUpdated: jest.fn() };
    const posthog = { capture: jest.fn() };
    const notifications = { markReadBySubject: jest.fn(async () => undefined) };
    const service = new PostViewsService(
      prisma as any,
      cache as any,
      redis as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any,
    );
    return { service, prisma, findMany };
  }

  it('expands flat repost and quoted post IDs into the batch', async () => {
    const { service, prisma, findMany } = makeBatchService();
    findMany.mockResolvedValueOnce([
      { id: 'repost-shell', kind: 'repost', repostedPostId: 'original', quotedPostId: null },
      { id: 'quote-post', kind: 'post', repostedPostId: null, quotedPostId: 'quoted' },
    ]);

    const markViewed = jest.spyOn(service, 'markViewed').mockResolvedValue(undefined);

    await service.markViewedBatch('viewer', ['repost-shell', 'quote-post'], null, 'feed_scroll');

    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['repost-shell', 'quote-post'] }, deletedAt: null },
      select: { id: true, kind: true, repostedPostId: true, quotedPostId: true },
    });
    const marked = markViewed.mock.calls.map((c) => c[1]).sort();
    expect(marked).toEqual(['original', 'quote-post', 'quoted', 'repost-shell']);
  });

  it('does not expand non-repost posts without quotedPostId', async () => {
    const { service, findMany } = makeBatchService();
    findMany.mockResolvedValueOnce([
      { id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null },
    ]);

    const markViewed = jest.spyOn(service, 'markViewed').mockResolvedValue(undefined);

    await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');

    expect(markViewed).toHaveBeenCalledTimes(1);
    expect(markViewed).toHaveBeenCalledWith('viewer', 'plain', null, 'feed_scroll');
  });
});
