import { PostViewsService } from './post-views.service';

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
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
        findUnique: jest.fn(async () => null),
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
        updateMany: jest.fn(async () => ({ count: 1 })),
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
    const service = new PostViewsService(prisma as any,
      cache as any,
      redis as any,
      cacheInvalidation as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any, new PostsReadService(prisma as any as never), new PostsWriteService(prisma as any as never));
    return { service, prisma, tx, redis, cacheInvalidation, presenceRealtime, posthog, notifications };
  }

  it('records a Board open even immediately after an impression, with an independent 30s gate', async () => {
    const { service, prisma, posthog } = makeService();
    await service.markViewed('viewer', 'p1', null, 'post_open');
    expect(prisma.postView.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ postId: 'p1', userId: 'viewer', post: { kind: 'board' }, OR: expect.any(Array) }),
      data: { lastOpenedAt: expect.any(Date), openCount: { increment: 1 } },
    });
    expect(posthog.capture).toHaveBeenCalledWith('viewer', 'board_thread_opened', expect.any(Object));
  });

  it('feed impressions never update Board open history or mark its notifications read', async () => {
    const { service, prisma, notifications } = makeService();
    prisma.post.findFirst.mockImplementation(async (args?: any) => args.where.kind ? null as any : { id: 'p1', visibility: 'public', userId: 'author' });
    await service.markViewed('viewer', 'p1', null, 'feed_scroll');
    expect(prisma.postView.updateMany).not.toHaveBeenCalled();
    expect(notifications.markReadBySubject).not.toHaveBeenCalled();
  });

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
  function makeBatchService(opts?: {
    existingViews?: Array<{ postId: string; lastSeenAt: Date; lastImpressionAt: Date }>;
    createdPostIds?: string[];
  }) {
    const existingViews = opts?.existingViews ?? [];
    const createdPostIds = opts?.createdPostIds;
    const expandRows: Array<{
      id: string;
      kind: string;
      repostedPostId: string | null;
      quotedPostId: string | null;
    }> = [];
    const detailRows: Array<{
      id: string;
      visibility: string;
      userId: string;
      viewerCount: number;
      totalViewCount: number;
    }> = [];
    const findMany = jest.fn(async (args: { select?: Record<string, unknown> }) => {
      if (args?.select && 'kind' in args.select) return expandRows;
      return detailRows;
    });
    const tx = {
      postView: {
        createManyAndReturn: jest.fn(async (args: { data: Array<{ postId: string }> }) => {
          const ids = createdPostIds ?? args.data.map((row) => row.postId);
          return ids.map((postId) => ({ postId }));
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
        updateManyAndReturn: jest.fn(async (args: any) => args.where.postId.in.map((postId: string) => ({ postId }))),
      },
      postAnonView: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      post: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
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
        findMany: jest.fn(async () => existingViews),
        findUnique: jest.fn(async () => null),
      },
      postAnonView: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
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
    const service = new PostViewsService(prisma as any,
      cache as any,
      redis as any,
      cacheInvalidation as any,
      presenceRealtime as any,
      posthog as any,
      notifications as any, new PostsReadService(prisma as any as never), new PostsWriteService(prisma as any as never));
    return {
      service,
      prisma,
      tx,
      findMany,
      expandRows,
      detailRows,
      notifications,
      cacheInvalidation,
      posthog,
      presenceRealtime,
    };
  }

  it.each([0, 60_000])('never adds a person or a guest for John revisiting with a browser ID after %sms', async (age) => {
    const last = new Date(Date.now() - age);
    const { service, detailRows, prisma, tx } = makeBatchService({
      existingViews: [{ postId: 'seen', lastSeenAt: last, lastImpressionAt: last }],
    });
    detailRows.push({ id: 'seen', visibility: 'public', userId: 'author', viewerCount: 4, totalViewCount: 7 });
    const acks = await service.markViewedBatch('john', ['seen'], 'anonymous_browser', 'feed_scroll');
    expect(acks).toEqual([{ id: 'seen', uniqueCounted: false, totalCounted: age > 0, viewerCount: 4, totalViewCount: age > 0 ? 8 : 7 }]);
    expect(prisma.postAnonView.createMany).not.toHaveBeenCalled();
    expect(tx.postView.createManyAndReturn).not.toHaveBeenCalled();
    for (const [args] of tx.post.updateMany.mock.calls as unknown as Array<[{ data: object }]>) {
      expect(args.data).not.toHaveProperty('viewerCount');
    }
  });

  it('does not increment totals when another overlapping batch already claimed the impression', async () => {
    const { service, detailRows, tx } = makeBatchService({ existingViews: [{ postId: 'plain', lastSeenAt: new Date(0), lastImpressionAt: new Date(0) }] });
    detailRows.push({ id: 'plain', userId: 'author', visibility: 'public', viewerCount: 1, totalViewCount: 1 });
    tx.postView.updateManyAndReturn.mockResolvedValue([]);
    const acks = await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');
    expect(acks[0]?.totalCounted).toBe(false);
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });

  it('counts quoted content as an impression without claiming its thread was opened', async () => {
    const { service, expandRows, detailRows } = makeBatchService();
    expandRows.push({ id: 'opened', kind: 'board', repostedPostId: null, quotedPostId: 'embedded' });
    for (const id of ['opened', 'embedded']) detailRows.push({ id, visibility: 'public', userId: 'author', viewerCount: 0, totalViewCount: 0 });
    const opens = jest.spyOn(service as any, 'recordOpen').mockResolvedValue(undefined);
    const acks = await service.markViewedBatch('viewer', ['opened'], null, 'post_open');
    expect(acks.map(ack => ack.id)).toEqual(['opened', 'embedded']);
    expect(opens).toHaveBeenCalledTimes(1);
    expect(opens).toHaveBeenCalledWith('viewer', 'opened', null, 'post_open');
  });

  it('expands flat repost and quoted post IDs into one authenticated write', async () => {
    const { service, prisma, expandRows, detailRows, notifications, tx } = makeBatchService();
    expandRows.push(
      { id: 'repost-shell', kind: 'repost', repostedPostId: 'original', quotedPostId: null },
      { id: 'quote-post', kind: 'post', repostedPostId: null, quotedPostId: 'quoted' },
    );
    for (const id of ['repost-shell', 'quote-post', 'original', 'quoted']) {
      detailRows.push({ id, visibility: 'public', userId: 'author', viewerCount: 1, totalViewCount: 1 });
    }
    const markViewed = jest.spyOn(service, 'markViewed');

    const acks = await service.markViewedBatch(
      'viewer',
      ['repost-shell', 'quote-post'],
      null,
      'feed_scroll',
    );

    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['repost-shell', 'quote-post'] }, deletedAt: null },
      select: { id: true, kind: true, repostedPostId: true, quotedPostId: true },
    });
    expect(markViewed).not.toHaveBeenCalled();
    expect(tx.postView.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.postView.createManyAndReturn.mock.calls[0][0].data.map((row: { postId: string }) => row.postId).sort()).toEqual(
      ['original', 'quote-post', 'quoted', 'repost-shell'],
    );
    expect(acks.map((ack) => ack.id).sort()).toEqual(['original', 'quote-post', 'quoted', 'repost-shell']);
    expect(notifications.markReadBySubjects).toHaveBeenCalledTimes(1);
    expect(notifications.markReadBySubjects).toHaveBeenCalledWith(
      'viewer',
      expect.arrayContaining(['original', 'quote-post', 'quoted', 'repost-shell']),
    );
    expect(notifications.markReadBySubject).not.toHaveBeenCalled();
  });

  it('does not expand non-repost posts without quotedPostId', async () => {
    const { service, expandRows, detailRows, notifications, tx, posthog } = makeBatchService();
    expandRows.push({ id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null });
    detailRows.push({ id: 'plain', visibility: 'public', userId: 'author', viewerCount: 4, totalViewCount: 7 });

    const acks = await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');

    expect(acks).toEqual([
      { id: 'plain', uniqueCounted: true, totalCounted: true, viewerCount: 5, totalViewCount: 8 },
    ]);
    expect(tx.post.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['plain'] } },
      data: expect.objectContaining({
        viewerCount: { increment: 1 },
        totalViewCount: { increment: 1 },
      }),
    });
    expect(posthog.capture).toHaveBeenCalled();
    expect(notifications.markReadBySubjects).toHaveBeenCalledWith('viewer', ['plain']);
  });

  it('refreshes last-seen without incrementing unique or total inside the impression window', async () => {
    const lastSeenAt = new Date(Date.now() - 20_000);
    const lastImpressionAt = new Date();
    const { service, expandRows, detailRows, tx, cacheInvalidation, posthog } = makeBatchService({
      existingViews: [{ postId: 'plain', lastSeenAt, lastImpressionAt }],
    });
    expandRows.push({ id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null });
    detailRows.push({ id: 'plain', visibility: 'public', userId: 'author', viewerCount: 4, totalViewCount: 7 });

    const acks = await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');

    expect(acks).toEqual([
      { id: 'plain', uniqueCounted: false, totalCounted: false, viewerCount: 4, totalViewCount: 7 },
    ]);
    expect(tx.postView.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.postView.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        postId: { in: ['plain'] },
        lastSeenAt: { lt: expect.any(Date) },
      }),
      data: expect.objectContaining({ seenCount: { increment: 1 } }),
    });
    expect(tx.post.updateMany).not.toHaveBeenCalled();
    expect(cacheInvalidation.bumpForYouUser).toHaveBeenCalledWith('viewer');
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('does not bump For You when a repeat view is still inside the last-seen buffer', async () => {
    const recent = new Date();
    const { service, expandRows, detailRows, cacheInvalidation } = makeBatchService({
      existingViews: [{ postId: 'plain', lastSeenAt: recent, lastImpressionAt: recent }],
    });
    expandRows.push({ id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null });
    detailRows.push({ id: 'plain', visibility: 'public', userId: 'author', viewerCount: 4, totalViewCount: 7 });

    await service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll');

    expect(cacheInvalidation.bumpForYouUser).not.toHaveBeenCalled();
  });

  it('still returns view acks when mark-read fails', async () => {
    const { service, expandRows, detailRows, notifications } = makeBatchService();
    expandRows.push({ id: 'plain', kind: 'post', repostedPostId: null, quotedPostId: null });
    detailRows.push({ id: 'plain', visibility: 'public', userId: 'author', viewerCount: 1, totalViewCount: 1 });
    notifications.markReadBySubjects.mockRejectedValueOnce(new Error('db down'));

    await expect(service.markViewedBatch('viewer', ['plain'], null, 'feed_scroll')).resolves.toEqual([
      { id: 'plain', uniqueCounted: true, totalCounted: true, viewerCount: 2, totalViewCount: 2 },
    ]);
  });
});
