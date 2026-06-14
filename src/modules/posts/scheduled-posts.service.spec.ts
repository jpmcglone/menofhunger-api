import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScheduledPostsService } from './scheduled-posts.service';

function makeScheduledUser(overrides: Partial<{ premium: boolean; premiumPlus: boolean; verifiedStatus: string }> = {}) {
  return {
    premium: true,
    premiumPlus: false,
    verifiedStatus: 'verified',
    ...overrides,
  };
}

function makeHoldingRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'sched-1',
    createdAt: new Date(),
    body: 'Hello',
    isDraft: true,
    scheduledAt: new Date(Date.now() + 10 * 60 * 1000),
    scheduledVisibility: 'public',
    scheduledCommunityGroupId: null,
    scheduledPollJson: null,
    scheduledError: null,
    scheduledFailedAt: null,
    deletedAt: null,
    userId: 'user-1',
    user: {
      id: 'user-1',
      username: 'peter',
      name: 'Peter',
      premium: true,
      premiumPlus: false,
      isOrganization: false,
      stewardBadgeEnabled: false,
      verifiedStatus: 'verified',
      avatarKey: null,
      avatarUpdatedAt: null,
      bannedAt: null,
    },
    media: [],
    mentions: [],
    ...overrides,
  };
}

function makeService(prismaOverrides: Record<string, any> = {}, mutationOverride?: any) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => makeScheduledUser()),
    },
    post: {
      create: jest.fn(async () => makeHoldingRow()),
      count: jest.fn(async () => 0), // default: user has 0 queued posts
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => makeHoldingRow()),
      update: jest.fn(async () => makeHoldingRow()),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    communityGroupMember: {
      findUnique: jest.fn(async () => ({ status: 'active' })),
    },
    postMedia: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    $transaction: jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        const tx: any = {
          post: {
            update: jest.fn(async () => makeHoldingRow()),
          },
          postMedia: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            createMany: jest.fn(async () => ({ count: 0 })),
          },
        };
        return fn(tx);
      }
      return Promise.all(fn);
    }),
    ...prismaOverrides,
  };

  const mutation: any = mutationOverride ?? {
    createPost: jest.fn(async () => ({
      post: {
        ...makeHoldingRow(),
        id: 'live-post-1',
        visibility: 'public',
        isDraft: false,
        scheduledAt: null,
      },
    })),
  };

  const realtime: any = {
    emitScheduledPostPublished: jest.fn(),
    emitScheduledPostFailed: jest.fn(),
  };

  const appConfig: any = { r2: () => ({ publicBaseUrl: 'https://assets.example.com' }) };
  const service = new ScheduledPostsService(prisma, mutation, realtime, appConfig);
  return { service, prisma, mutation, realtime };
}

const VALID_FUTURE = new Date(Date.now() + 10 * 60 * 1000); // +10 min
// Near-future (< 5 min) is now allowed — the UI prevents it but the API accepts
// it gracefully; the cron publishes it on its next sweep.
const NEAR_FUTURE = new Date(Date.now() + 60 * 1000); // +1 min
const TOO_FAR = new Date(Date.now() + 61 * 24 * 60 * 60 * 1000); // +61 days

describe('ScheduledPostsService', () => {
  describe('createScheduled', () => {
    it('throws if user is not premium', async () => {
      const { service } = makeService({
        user: { findUnique: jest.fn(async () => makeScheduledUser({ premium: false, premiumPlus: false })) },
      });

      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: VALID_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts scheduledAt less than 5 min in future (cron will publish on next sweep)', async () => {
      const { service } = makeService();
      // Should not throw — the near-future window is allowed server-side.
      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: NEAR_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).resolves.toBeDefined();
    });

    it('throws if scheduledAt is more than 60 days out', async () => {
      const { service } = makeService();
      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: TOO_FAR, media: null, poll: null, communityGroupId: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws if visibility is onlyMe', async () => {
      const { service } = makeService();
      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'onlyMe', scheduledAt: VALID_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws if user is not found', async () => {
      const { service } = makeService({
        user: { findUnique: jest.fn(async () => null) },
      });
      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: VALID_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).rejects.toThrow(NotFoundException);
    });

    it('persists a holding row with scheduledAt and scheduledVisibility', async () => {
      const { service, prisma } = makeService();

      const result = await service.createScheduled({
        userId: 'user-1',
        body: 'good morning everyone',
        visibility: 'public',
        scheduledAt: VALID_FUTURE,
        media: null,
        poll: null,
        communityGroupId: null,
      });

      expect(prisma.post.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isDraft: true,
            visibility: 'onlyMe',
            scheduledAt: VALID_FUTURE,
            scheduledVisibility: 'public',
          }),
        }),
      );
      expect(result.scheduledAt).toBeDefined();
      expect(result.scheduledVisibility).toBe('public');
    });
  });

  describe('listScheduled', () => {
    it('only queries isDraft=true rows with scheduledAt set', async () => {
      const postMock = {
        findMany: jest.fn(async () => [makeHoldingRow()]),
      };
      const { service } = makeService({ post: postMock });

      await service.listScheduled({ userId: 'user-1', cursor: null });

      const call = (postMock.findMany as jest.Mock).mock.calls[0]?.[0];
      const andClauses = call?.where?.AND ?? [];
      expect(andClauses).toContainEqual({ isDraft: true });
      expect(andClauses).toContainEqual({ scheduledAt: { not: null } });
    });
  });

  describe('deleteScheduled', () => {
    it('throws if the post is not a scheduled row', async () => {
      const { service } = makeService({
        post: {
          findUnique: jest.fn(async () => ({
            ...makeHoldingRow(),
            isDraft: true,
            scheduledAt: null, // not scheduled
          })),
          update: jest.fn(async () => ({})),
        },
      });
      await expect(service.deleteScheduled({ userId: 'user-1', scheduledPostId: 'sched-1' })).rejects.toThrow(ForbiddenException);
    });

    it('soft-deletes the holding row', async () => {
      const { service, prisma } = makeService();
      const result = await service.deleteScheduled({ userId: 'user-1', scheduledPostId: 'sched-1' });
      expect(result.success).toBe(true);
      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sched-1' }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
    });
  });

  describe('publishDue', () => {
    it('skips a row if atomic claim returns count=0 (already claimed)', async () => {
      const duePost = makeHoldingRow({ id: 'sched-due', scheduledAt: new Date(Date.now() - 1000) });
      const { service, mutation } = makeService({
        post: {
          findMany: jest.fn(async () => [duePost]),
          updateMany: jest.fn(async () => ({ count: 0 })),
          update: jest.fn(async () => ({})),
        },
      });

      await service.publishDue(new Date());

      expect(mutation.createPost).not.toHaveBeenCalled();
    });

    it('calls createPost with stored body, visibility, and media when claim succeeds', async () => {
      const duePost = makeHoldingRow({ id: 'sched-due', scheduledAt: new Date(Date.now() - 1000) });
      const { service, prisma, mutation, realtime } = makeService({
        post: {
          findMany: jest.fn(async () => [duePost]),
          updateMany: jest.fn(async () => ({ count: 1 })),
          update: jest.fn(async () => ({})),
        },
      });

      await service.publishDue(new Date());

      expect(mutation.createPost).toHaveBeenCalledWith(
        expect.objectContaining({ body: duePost.body, visibility: 'public' }),
      );
      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sched-due' } }),
      );
      expect(realtime.emitScheduledPostPublished).toHaveBeenCalledWith('user-1', expect.objectContaining({ scheduledId: 'sched-due' }));
    });

    it('records failure and emits failed event when createPost throws', async () => {
      const duePost = makeHoldingRow({ id: 'sched-err', scheduledAt: new Date(Date.now() - 1000) });
      const { service, prisma, realtime } = makeService(
        {
          post: {
            findMany: jest.fn(async () => [duePost]),
            updateMany: jest.fn(async () => ({ count: 1 })),
            update: jest.fn(async () => ({})),
          },
        },
        { createPost: jest.fn(async () => { throw new Error('publish failed'); }) },
      );

      await service.publishDue(new Date());

      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sched-err' },
          data: expect.objectContaining({ scheduledError: 'publish failed' }),
        }),
      );
      expect(realtime.emitScheduledPostFailed).toHaveBeenCalledWith('user-1', expect.objectContaining({ scheduledId: 'sched-err', error: 'publish failed' }));
    });

    it('does not query rows whose scheduledAt is in the future', async () => {
      const futurePost = makeHoldingRow({ id: 'future', scheduledAt: new Date(Date.now() + 60_000) });
      const { service, prisma } = makeService({
        post: {
          findMany: jest.fn(async () => []),
          updateMany: jest.fn(async () => ({ count: 0 })),
        },
      });

      await service.publishDue(new Date());

      const call = (prisma.post.findMany as jest.Mock).mock.calls[0]?.[0];
      const andClauses = call?.where?.AND ?? [];
      expect(andClauses).toContainEqual(expect.objectContaining({ scheduledAt: expect.objectContaining({ lte: expect.any(Date) }) }));
      // The future post should not have been published.
      expect(futurePost.id).toBe('future'); // sanity
    });

    it('sets scheduledError and emits failed (once) when author is no longer premium', async () => {
      const duePost = makeHoldingRow({ id: 'sched-lapsed', scheduledAt: new Date(Date.now() - 1000), scheduledError: null });
      const { service, prisma, mutation, realtime } = makeService({
        user: {
          findUnique: jest.fn(async () => ({ premium: false, premiumPlus: false, verifiedStatus: 'verified', bannedAt: null })),
        },
        post: {
          findMany: jest.fn(async () => [duePost]),
          update: jest.fn(async () => ({})),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      });

      await service.publishDue(new Date());

      expect(mutation.createPost).not.toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sched-lapsed' },
          data: expect.objectContaining({ scheduledError: expect.stringContaining('premium') }),
        }),
      );
      expect(realtime.emitScheduledPostFailed).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-emit failed event when scheduledError is already set (flag-once)', async () => {
      const duePost = makeHoldingRow({
        id: 'sched-already-failed',
        scheduledAt: new Date(Date.now() - 1000),
        scheduledError: 'Scheduled posts require premium. Renew your subscription to publish.',
      });
      const { service, realtime } = makeService({
        user: {
          findUnique: jest.fn(async () => ({ premium: false, premiumPlus: false, verifiedStatus: 'verified', bannedAt: null })),
        },
        post: {
          findMany: jest.fn(async () => [duePost]),
          update: jest.fn(async () => ({})),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      });

      await service.publishDue(new Date());

      expect(realtime.emitScheduledPostFailed).not.toHaveBeenCalled();
    });

    it('sets scheduledError when author is banned', async () => {
      const duePost = makeHoldingRow({ id: 'sched-banned', scheduledAt: new Date(Date.now() - 1000), scheduledError: null });
      const { service, mutation, realtime } = makeService({
        user: {
          findUnique: jest.fn(async () => ({ premium: true, premiumPlus: false, verifiedStatus: 'verified', bannedAt: new Date() })),
        },
        post: {
          findMany: jest.fn(async () => [duePost]),
          update: jest.fn(async () => ({})),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      });

      await service.publishDue(new Date());

      expect(mutation.createPost).not.toHaveBeenCalled();
      expect(realtime.emitScheduledPostFailed).toHaveBeenCalledTimes(1);
    });

    it('per-user fairness: second user publishes even when first user has many due rows', async () => {
      const user1Posts = Array.from({ length: 15 }, (_, i) =>
        makeHoldingRow({ id: `u1-${i}`, userId: 'user-1', scheduledAt: new Date(Date.now() - 1000) }),
      );
      const user2Post = makeHoldingRow({ id: 'u2-0', userId: 'user-2', scheduledAt: new Date(Date.now() - 500) });
      const allPosts = [...user1Posts, user2Post];

      const { service, mutation } = makeService({
        user: {
          findUnique: jest.fn(async () => makeScheduledUser()),
        },
        post: {
          findMany: jest.fn(async () => allPosts),
          update: jest.fn(async () => ({})),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      });

      await service.publishDue(new Date());

      // user-2's post must have been attempted (createPost called with userId user-2).
      const calls = (mutation.createPost as jest.Mock).mock.calls;
      const user2Published = calls.some((call: any[]) => call[0]?.userId === 'user-2' || call[0]?.userId === undefined);
      // createPost is called with the body, not userId directly; verify via update calls
      // The simplest invariant: user-2's post was processed, meaning createPost was called
      // at least 11 times (10 for user-1 cap + 1 for user-2).
      expect(mutation.createPost).toHaveBeenCalledTimes(11);
      void user2Published; // suppress unused warning
    });
  });

  describe('createScheduled queued cap', () => {
    it('throws BadRequestException when user already has 25 queued posts', async () => {
      const { service } = makeService({
        post: {
          count: jest.fn(async () => 25),
          create: jest.fn(async () => makeHoldingRow()),
        },
      });

      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: VALID_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows creating when user has 24 queued posts', async () => {
      const { service } = makeService({
        post: {
          count: jest.fn(async () => 24),
          create: jest.fn(async () => makeHoldingRow()),
        },
      });

      await expect(
        service.createScheduled({ userId: 'u', body: 'hello', visibility: 'public', scheduledAt: VALID_FUTURE, media: null, poll: null, communityGroupId: null }),
      ).resolves.toBeDefined();
    });
  });
});
