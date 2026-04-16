import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostsService } from './posts.service';

// ─── Deps factory ────────────────────────────────────────────────────────────
// PostsService has 12 collaborators. For the auth/error paths exercised here we
// only need `prisma` and `cacheInvalidation` to respond; the rest are
// no-op'd. Tests that need deeper behavior can override specific fields.

function makeService(
  prismaOverrides: Record<string, any> = {},
  extraOverrides: Partial<Record<string, any>> = {},
) {
  const prisma: any = {
    post: {
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(),
    },
    postPoll: { updateMany: jest.fn(async () => ({ count: 0 })) },
    bookmark: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    hashtag: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    hashtagVariant: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    user: { update: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        const tx: any = {
          post: {
            findMany: jest.fn(async () => []),
            update: jest.fn(async () => ({})),
          },
          postPoll: { updateMany: jest.fn(async () => ({ count: 0 })) },
          bookmark: { deleteMany: jest.fn(async () => ({ count: 0 })) },
          hashtag: { update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
          hashtagVariant: { update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
          user: { update: jest.fn(async () => ({})) },
          $executeRaw: jest.fn(async () => 0),
        };
        return fn(tx);
      }
      return Promise.all(fn);
    }),
    ...prismaOverrides,
  };

  const notifications: any = {
    deleteBySubjectPostId: jest.fn(async () => undefined),
    deleteByActorPostId: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
  };
  const requestCache: any = {};
  const presenceRealtime: any = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsCommentDeleted: jest.fn(),
  };
  const polls: any = {};
  const viewerContext: any = {};
  const cacheInvalidation: any = {
    bumpForPostWrite: jest.fn(async () => undefined),
  };
  const appConfig: any = {
    r2: jest.fn(() => null),
  };
  const postViews: any = {};
  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const posthog: any = { capture: jest.fn() };
  const redis: any = {};

  const deps = {
    prisma,
    notifications,
    requestCache,
    presenceRealtime,
    polls,
    viewerContext,
    cacheInvalidation,
    appConfig,
    postViews,
    jobs,
    posthog,
    redis,
    ...extraOverrides,
  };

  const service = new PostsService(
    deps.prisma,
    deps.notifications,
    deps.requestCache,
    deps.presenceRealtime,
    deps.polls,
    deps.viewerContext,
    deps.cacheInvalidation,
    deps.appConfig,
    deps.postViews,
    deps.jobs,
    deps.posthog,
    deps.redis,
  );

  return { service, deps };
}

// ─── deletePost ──────────────────────────────────────────────────────────────

describe('PostsService.deletePost', () => {
  it('throws NotFoundException when postId is empty', async () => {
    const { service } = makeService();
    await expect(
      service.deletePost({ userId: 'u1', postId: '   ' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when post does not exist', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue(null);
    await expect(
      service.deletePost({ userId: 'u1', postId: 'missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when a different user tries to delete the post', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'author',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: null,
      repostedPostId: null,
      quotedPostId: null,
    });

    await expect(
      service.deletePost({ userId: 'someone-else', postId: 'p1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns success without touching the DB if the post is already soft-deleted', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      deletedAt: new Date(),
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: null,
      repostedPostId: null,
      quotedPostId: null,
    });

    const result = await service.deletePost({ userId: 'u1', postId: 'p1' });
    expect(result).toEqual({ success: true });
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('soft-deletes the post and bumps caches on success', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique
      .mockResolvedValueOnce({
        id: 'p1',
        userId: 'u1',
        deletedAt: null,
        hashtags: [],
        hashtagCasings: [],
        topics: ['depression'],
        kind: 'regular',
        parentId: null,
        repostedPostId: null,
        quotedPostId: null,
      });

    const result = await service.deletePost({ userId: 'u1', postId: 'p1' });
    expect(result).toEqual({ success: true });
    expect(deps.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(deps.cacheInvalidation.bumpForPostWrite).toHaveBeenCalledWith({ topics: ['depression'] });
    expect(deps.notifications.deleteBySubjectPostId).toHaveBeenCalledWith('p1');
  });

  it('schedules a trending-score refresh for the reposted target', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'repost',
      parentId: null,
      repostedPostId: 'target',
      quotedPostId: null,
    });

    await service.deletePost({ userId: 'u1', postId: 'p1' });
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ postId: 'target' }),
      expect.any(Object),
    );
  });
});

// ─── updatePost ──────────────────────────────────────────────────────────────

describe('PostsService.updatePost', () => {
  const baseFindUniqueResult = {
    id: 'p1',
    userId: 'u1',
    body: 'original',
    deletedAt: null,
    parentId: null,
    visibility: 'public' as const,
    editCount: 0,
    createdAt: new Date(),
    editedAt: null,
    hashtags: [],
    hashtagCasings: [],
    topics: [],
    mentions: [],
    media: [],
    poll: null,
    user: {
      id: 'u1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
      bannedAt: null,
      verifiedStatus: 'none',
      premium: false,
      premiumPlus: false,
      isOrganization: false,
    },
  };

  it('rejects empty body with BadRequestException', async () => {
    const { service } = makeService();
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects missing postId with NotFoundException', async () => {
    const { service } = makeService();
    await expect(
      service.updatePost({ userId: 'u1', postId: '', body: 'hi' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when post is missing', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue(null);
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'hi' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects edits from other users', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({ ...baseFindUniqueResult, userId: 'other' });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects editing a deleted post', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      deletedAt: new Date(),
    });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects editing a reply', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      parentId: 'parent-1',
    });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects editing a post whose poll already has votes', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      poll: { id: 'poll-1', totalVoteCount: 2 },
    });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'hi' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects edits after the 30-minute window has elapsed', async () => {
    const { service, deps } = makeService();
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      createdAt: anHourAgo,
    });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'updated' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects edits once the 3-edit limit is reached', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      editCount: 3,
    });
    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'updated' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows siteAdmin to bypass age and edit-count limits', async () => {
    const { service, deps } = makeService();
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    deps.prisma.post.findUnique.mockResolvedValue({
      ...baseFindUniqueResult,
      createdAt: anHourAgo,
      editCount: 9,
    });

    // The service continues past the window/limit checks for siteAdmin, so it
    // must reach the update path. We reject early on the internal `$transaction`
    // call to avoid mocking the entire update flow — the point is that the
    // gating throws *stop* firing for siteAdmin.
    deps.prisma.$transaction.mockRejectedValue(new Error('__reached_transaction__'));

    await expect(
      service.updatePost({ userId: 'u1', postId: 'p1', body: 'updated', isSiteAdmin: true }),
    ).rejects.toThrow('__reached_transaction__');
  });
});
