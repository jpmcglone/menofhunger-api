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
