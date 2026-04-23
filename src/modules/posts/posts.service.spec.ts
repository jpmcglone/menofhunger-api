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
    emitPostsInteraction: jest.fn(),
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

// ─── deletePost: comment-count integrity ─────────────────────────────────────
//
// Regression coverage for the bug where the UI showed a doubled commentCount
// after a reply was created (the frontend optimistic bump landed on top of the
// server count). The contract this section locks in:
//
//   • A reply's commentCount belongs to ONE parent only — its direct parent.
//   • Deleting a reply decrements that direct parent's commentCount by exactly 1.
//   • The commentCount on `rootId` (when different from the direct parent) MUST
//     NOT be touched. It represents direct children only, never descendants.
//   • The realtime `comment_deleted` event targets the direct parent.

describe('PostsService.deletePost — comment-count integrity', () => {
  function makeServiceWithExecuteRawSpy() {
    const executeRawSpy = jest.fn(async () => 0);
    const txUpdateSpy = jest.fn(async () => ({}));
    const transactionImpl = jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        const tx: any = {
          post: {
            findMany: jest.fn(async () => []),
            update: txUpdateSpy,
          },
          postPoll: { updateMany: jest.fn(async () => ({ count: 0 })) },
          bookmark: { deleteMany: jest.fn(async () => ({ count: 0 })) },
          hashtag: { update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
          hashtagVariant: { update: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
          user: { update: jest.fn(async () => ({})) },
          $executeRaw: executeRawSpy,
        };
        return fn(tx);
      }
      return Promise.all(fn);
    });
    const { service, deps } = makeService({ $transaction: transactionImpl });
    return { service, deps, executeRawSpy, txUpdateSpy };
  }

  it('decrements the direct parent commentCount when deleting a reply', async () => {
    const { service, deps, executeRawSpy } = makeServiceWithExecuteRawSpy();
    deps.prisma.post.findUnique.mockResolvedValueOnce({
      id: 'reply-1',
      userId: 'u1',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: 'parent-1',
      repostedPostId: null,
      quotedPostId: null,
    });
    // Second findUnique fetches the parent's updated commentCount for the realtime emit.
    deps.prisma.post.findUnique.mockResolvedValueOnce({ commentCount: 3 });

    await service.deletePost({ userId: 'u1', postId: 'reply-1' });

    // The decrement is issued via raw SQL with GREATEST(0, ...) — confirm the
    // parent id is interpolated into the executed query.
    expect(executeRawSpy).toHaveBeenCalledTimes(1);
    const call = executeRawSpy.mock.calls[0] as unknown as unknown[];
    const strings = call[0] as TemplateStringsArray | string[];
    const values = call.slice(1);
    expect(Array.isArray(strings)).toBe(true);
    expect(values).toContain('parent-1');
    const joined = (strings as string[]).join(' ');
    expect(joined).toMatch(/UPDATE\s+"Post"/i);
    expect(joined).toMatch(/commentCount/);
  });

  it('does NOT issue a parent commentCount decrement when deleting a top-level post', async () => {
    const { service, deps, executeRawSpy } = makeServiceWithExecuteRawSpy();
    deps.prisma.post.findUnique.mockResolvedValueOnce({
      id: 'top-1',
      userId: 'u1',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: null,
      repostedPostId: null,
      quotedPostId: null,
    });

    await service.deletePost({ userId: 'u1', postId: 'top-1' });

    expect(executeRawSpy).not.toHaveBeenCalled();
  });

  it('emits realtime comment_deleted only to the direct parent (not the thread root)', async () => {
    // Setup: A is root, B is a reply to A, C is a reply to B. Deleting C must
    // emit comment_deleted for B and post_deleted for C — A must not receive any
    // commentCount-decrementing event from this delete.
    const { service, deps } = makeServiceWithExecuteRawSpy();
    deps.prisma.post.findUnique.mockResolvedValueOnce({
      id: 'C',
      userId: 'u1',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: 'B',
      repostedPostId: null,
      quotedPostId: null,
    });
    deps.prisma.post.findUnique.mockResolvedValueOnce({ commentCount: 0 });

    await service.deletePost({ userId: 'u1', postId: 'C' });

    const liveCalls = deps.presenceRealtime.emitPostsLiveUpdated.mock.calls;
    const targets = liveCalls.map((c: any[]) => c[0]);

    // post_deleted for the comment itself targets C.
    expect(targets).toContain('C');
    // comment_deleted for the parent targets B.
    expect(targets).toContain('B');
    // The thread root A must never appear — no descendant-aware bookkeeping.
    expect(targets).not.toContain('A');

    // The reason on the parent emit must be 'comment_deleted' (so the post-cache
    // plugin clears the optimistic bump for B and patches the count).
    const parentEmit = liveCalls.find((c: any[]) => c[0] === 'B');
    expect(parentEmit?.[1]?.reason).toBe('comment_deleted');
    expect(typeof parentEmit?.[1]?.patch?.commentCount).toBe('number');

    // The typed delete event also fires on B (so thread subscribers can drop the row).
    expect(deps.presenceRealtime.emitPostsCommentDeleted).toHaveBeenCalledWith(
      'B',
      expect.objectContaining({ parentPostId: 'B', commentId: 'C' }),
    );
  });

  it('emits the parent commentCount via the realtime patch for cache reconciliation', async () => {
    const { service, deps } = makeServiceWithExecuteRawSpy();
    deps.prisma.post.findUnique.mockResolvedValueOnce({
      id: 'reply-1',
      userId: 'u1',
      deletedAt: null,
      hashtags: [],
      hashtagCasings: [],
      topics: [],
      kind: 'regular',
      parentId: 'parent-1',
      repostedPostId: null,
      quotedPostId: null,
    });
    // Authoritative parent count after the in-tx decrement.
    deps.prisma.post.findUnique.mockResolvedValueOnce({ commentCount: 7 });

    await service.deletePost({ userId: 'u1', postId: 'reply-1' });

    const parentEmit = deps.presenceRealtime.emitPostsLiveUpdated.mock.calls.find(
      (c: any[]) => c[0] === 'parent-1',
    );
    expect(parentEmit).toBeDefined();
    expect(parentEmit?.[1]?.patch?.commentCount).toBe(7);
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

// ─── boost / unboost / repost — realtime fan-out ─────────────────────────────
//
// Regression coverage for: passive viewers of a post (not the author, not the
// actor) were not seeing live count updates after a boost / unboost / repost.
// The targeted `posts:interaction` event only reaches actor + author. We must
// ALSO emit `posts:liveUpdated` to the post room so every subscriber updates.

describe('PostsService — boost/unboost/repost room fan-out', () => {
  function setupBoostMocks(deps: any, opts: { boostCount: number }) {
    // ensureUserCanBoost
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    // userBlock count for the cross-block guard.
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    // boost createMany / deleteMany live on tx; the tx wrapper also reads the
    // updated boost count via tx.post.findUnique.
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        const tx: any = {
          boost: {
            createMany: jest.fn(async () => ({ count: 1 })),
            deleteMany: jest.fn(async () => ({ count: 1 })),
          },
          post: {
            update: jest.fn(async () => ({})),
            findUnique: jest.fn(async () => ({ boostCount: opts.boostCount })),
          },
        };
        return fn(tx);
      }
      return Promise.all(fn);
    });
    // bumpFeedGlobal lives on cacheInvalidation — extend the existing mock.
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    // Notifications used during boost.
    deps.notifications.upsertBoostNotification = jest.fn(async () => undefined);
    deps.notifications.deleteBoostNotification = jest.fn(async () => undefined);
    // postViews.markViewed is invoked.
    deps.postViews.markViewed = jest.fn(async () => undefined);
  }

  it('boostPost emits posts:liveUpdated to the post room with the new boostCount', async () => {
    const { service, deps } = makeService();
    setupBoostMocks(deps, { boostCount: 7 });
    // getById is heavy; stub it to skip visibility/group resolution.
    jest.spyOn(service as any, 'getById').mockResolvedValue({
      id: 'p1',
      userId: 'author',
      deletedAt: null,
      visibility: 'public',
      user: { id: 'author' },
      body: 'hi',
    });

    await service.boostPost({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        postId: 'p1',
        reason: 'boost_changed',
        patch: { boostCount: 7 },
        version: expect.any(String),
      }),
    );
  });

  it('unboostPost emits posts:liveUpdated to the post room with the new boostCount', async () => {
    const { service, deps } = makeService();
    setupBoostMocks(deps, { boostCount: 6 });
    jest.spyOn(service as any, 'getById').mockResolvedValue({
      id: 'p1',
      userId: 'author',
      deletedAt: null,
      visibility: 'public',
      user: { id: 'author' },
    });

    await service.unboostPost({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        reason: 'boost_changed',
        patch: { boostCount: 6 },
      }),
    );
  });

  it('boostPost still emits posts:interaction to actor + author for viewerHasBoosted UX', async () => {
    const { service, deps } = makeService();
    setupBoostMocks(deps, { boostCount: 7 });
    deps.presenceRealtime.emitPostsInteraction = jest.fn();
    jest.spyOn(service as any, 'getById').mockResolvedValue({
      id: 'p1',
      userId: 'author',
      deletedAt: null,
      visibility: 'public',
      user: { id: 'author' },
    });

    await service.boostPost({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsInteraction).toHaveBeenCalledTimes(1);
    const [recipients, payload] = deps.presenceRealtime.emitPostsInteraction.mock.calls[0];
    expect(Array.from(recipients as Set<string>).sort()).toEqual(['author', 'u1']);
    expect(payload).toEqual(
      expect.objectContaining({
        kind: 'boost',
        active: true,
        boostCount: 7,
      }),
    );
  });

  it('repostPost emits posts:liveUpdated to the canonical post room with the new repostCount', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    // Resolves the canonical (non-repost) target.
    deps.prisma.post.findFirst = jest.fn(async () => ({
      id: 'canonical-1',
      userId: 'author',
      visibility: 'public',
      kind: 'regular',
      repostedPostId: null,
    }));
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    // No existing repost yet.
    deps.prisma.post.findFirst = jest
      .fn()
      // Initial canonical lookup
      .mockResolvedValueOnce({
        id: 'canonical-1',
        userId: 'author',
        visibility: 'public',
        kind: 'regular',
        repostedPostId: null,
      })
      // existingRepost lookup
      .mockResolvedValueOnce(null);
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      const tx: any = {
        post: {
          create: jest.fn(async () => ({ id: 'repost-1' })),
          update: jest.fn(async () => ({ repostCount: 9 })),
        },
      };
      return fn(tx);
    });
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    deps.notifications.upsertRepostNotification = jest.fn(async () => undefined);
    deps.postViews.markViewed = jest.fn(async () => undefined);

    await service.repostPost({ userId: 'u1', postId: 'canonical-1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'canonical-1',
      expect.objectContaining({
        postId: 'canonical-1',
        reason: 'repost_changed',
        patch: { repostCount: 9 },
      }),
    );
  });

  it('unrepostPost emits posts:liveUpdated to the canonical post room with the new repostCount', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findFirst = jest
      .fn()
      // Initial target lookup
      .mockResolvedValueOnce({
        id: 'canonical-1',
        userId: 'author',
        kind: 'regular',
        repostedPostId: null,
      })
      // existingRepost lookup
      .mockResolvedValueOnce({ id: 'repost-1' })
      // canonical author lookup at the end
      .mockResolvedValueOnce({ userId: 'author' });
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      const tx: any = {
        post: {
          delete: jest.fn(async () => ({})),
          update: jest.fn(async () => ({ repostCount: 8 })),
        },
      };
      return fn(tx);
    });
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    deps.notifications.deleteRepostNotification = jest.fn(async () => undefined);

    await service.unrepostPost({ userId: 'u1', postId: 'canonical-1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'canonical-1',
      expect.objectContaining({
        reason: 'repost_changed',
        patch: { repostCount: 8 },
      }),
    );
  });

  it('boost room fan-out is best-effort: an emit failure does not break the boost', async () => {
    const { service, deps } = makeService();
    setupBoostMocks(deps, { boostCount: 1 });
    deps.presenceRealtime.emitPostsLiveUpdated = jest.fn(() => {
      throw new Error('redis down');
    });
    jest.spyOn(service as any, 'getById').mockResolvedValue({
      id: 'p1',
      userId: 'author',
      deletedAt: null,
      visibility: 'public',
      user: { id: 'author' },
    });

    await expect(service.boostPost({ userId: 'u1', postId: 'p1' })).resolves.toEqual(
      expect.objectContaining({ success: true, viewerHasBoosted: true, boostCount: 1 }),
    );
  });
});

// ─── runPostCreateSideEffects: mention notifications gated by group privacy ──
//
// The mention loop inside `runPostCreateSideEffects` must:
//   • notify all explicitly @mentioned users for non-group posts
//   • notify all mentioned users for posts in OPEN community groups
//   • notify only ACTIVE members for posts in PRIVATE (approval) community
//     groups — mentioning someone who can't read the post is a dead end and
//     leaks existence of private content.

describe('PostsService.runPostCreateSideEffects — mention privacy gating', () => {
  function setup() {
    const { service, deps } = makeService();
    deps.prisma.communityGroup = { findUnique: jest.fn() };
    deps.prisma.communityGroupMember = { findMany: jest.fn(async () => []) };
    deps.prisma.follow = { findMany: jest.fn(async () => []) };
    return { service, deps };
  }

  function basePost(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'post-1',
      userId: 'author',
      communityGroupId: null,
      ...overrides,
    } as any;
  }

  async function callSideEffects(service: PostsService, args: any): Promise<void> {
    await (service as any).runPostCreateSideEffects({
      actorUserId: 'author',
      post: basePost(args.postOverrides),
      parentId: null,
      parentAuthorUserId: null,
      threadPostsForRoles: [],
      bodyMentionIds: args.bodyMentionIds ?? [],
      bodyMentionSet: new Set(args.bodyMentionIds ?? []),
      bodySnippet: '',
      visibility: 'public',
      quotedInfo: null,
      didAwardStreak: false,
    });
  }

  it('notifies every mentioned user when the post is not in a community group', async () => {
    const { service, deps } = setup();
    await callSideEffects(service, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: null },
    });
    expect(deps.prisma.communityGroup.findUnique).not.toHaveBeenCalled();
    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls.map((c) => c[0].recipientUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('notifies every mentioned user when the post is in an OPEN community group', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(service, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: 'g1' },
    });

    expect(deps.prisma.communityGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1' } }),
    );
    expect(deps.prisma.communityGroupMember.findMany).not.toHaveBeenCalled();
    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls.map((c) => c[0].recipientUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('only notifies active members when the post is in a PRIVATE (approval) community group', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'approval' });
    deps.prisma.communityGroupMember.findMany.mockResolvedValue([{ userId: 'u1' }]);

    await callSideEffects(service, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: 'g1' },
    });

    expect(deps.prisma.communityGroupMember.findMany).toHaveBeenCalledWith({
      where: {
        groupId: 'g1',
        userId: { in: ['u1', 'u2'] },
        status: 'active',
      },
      select: { userId: true },
    });
    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls.map((c) => c[0].recipientUserId)).toEqual(['u1']);
  });

  it('suppresses all mentions for a private group when the membership lookup fails (fail closed)', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'approval' });
    deps.prisma.communityGroupMember.findMany.mockRejectedValue(new Error('db down'));

    await callSideEffects(service, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: 'g1' },
    });

    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls).toHaveLength(0);
  });

  it('skips group lookup when there are no mentions', async () => {
    const { service, deps } = setup();
    await callSideEffects(service, {
      bodyMentionIds: [],
      postOverrides: { communityGroupId: 'g1' },
    });
    expect(deps.prisma.communityGroup.findUnique).not.toHaveBeenCalled();
  });
});

// ─── assertCanReadCommunityGroup: open vs private gating ─────────────────────
//
// The read-access gate that group feeds use to decide whether a viewer may load
// posts. OPEN groups admit any signed-in, verified viewer. PRIVATE (approval)
// groups admit only active members. Site admins always pass.

describe('PostsService.assertCanReadCommunityGroup', () => {
  function setup() {
    const { service, deps } = makeService();
    deps.prisma.communityGroup = { findFirst: jest.fn() };
    deps.prisma.communityGroupMember = { findUnique: jest.fn() };
    deps.viewerContext.getViewer = jest.fn();
    deps.viewerContext.isVerified = (v: any) => Boolean(v?.verifiedStatus && v.verifiedStatus !== 'none');
    return { service, deps };
  }

  it('throws ForbiddenException when groupId is empty', async () => {
    const { service } = setup();
    await expect(service.assertCanReadCommunityGroup('u1', '   ')).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when the group does not exist', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue(null);
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'verified', siteAdmin: false });
    await expect(service.assertCanReadCommunityGroup('u1', 'gone')).rejects.toThrow(NotFoundException);
  });

  it('OPEN group: allows any verified signed-in viewer (non-member)', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'open' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'verified', siteAdmin: false });
    await expect(service.assertCanReadCommunityGroup('u1', 'g1')).resolves.toBeUndefined();
    expect(deps.prisma.communityGroupMember.findUnique).not.toHaveBeenCalled();
  });

  it('OPEN group: rejects unverified signed-in viewer', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'open' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'none', siteAdmin: false });
    await expect(service.assertCanReadCommunityGroup('u1', 'g1')).rejects.toThrow(ForbiddenException);
  });

  it('OPEN group: rejects anonymous viewer', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'open' });
    deps.viewerContext.getViewer.mockResolvedValue(null);
    await expect(service.assertCanReadCommunityGroup(null, 'g1')).rejects.toThrow(ForbiddenException);
  });

  it('PRIVATE group: allows active member', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'approval' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'verified', siteAdmin: false });
    deps.prisma.communityGroupMember.findUnique.mockResolvedValue({ status: 'active' });
    await expect(service.assertCanReadCommunityGroup('u1', 'g1')).resolves.toBeUndefined();
  });

  it('PRIVATE group: rejects verified non-member', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'approval' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'verified', siteAdmin: false });
    deps.prisma.communityGroupMember.findUnique.mockResolvedValue(null);
    await expect(service.assertCanReadCommunityGroup('u1', 'g1')).rejects.toThrow(ForbiddenException);
  });

  it('PRIVATE group: rejects pending member', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'approval' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'u1', verifiedStatus: 'verified', siteAdmin: false });
    deps.prisma.communityGroupMember.findUnique.mockResolvedValue({ status: 'pending' });
    await expect(service.assertCanReadCommunityGroup('u1', 'g1')).rejects.toThrow(ForbiddenException);
  });

  it('site admin always passes regardless of joinPolicy or membership', async () => {
    const { service, deps } = setup();
    deps.prisma.communityGroup.findFirst.mockResolvedValue({ joinPolicy: 'approval' });
    deps.viewerContext.getViewer.mockResolvedValue({ id: 'admin', verifiedStatus: 'none', siteAdmin: true });
    await expect(service.assertCanReadCommunityGroup('admin', 'g1')).resolves.toBeUndefined();
    expect(deps.prisma.communityGroupMember.findUnique).not.toHaveBeenCalled();
  });
});

// ─── listCommunityGroupsTimelinePosts: trending fallback ─────────────────────
// Trending should never be empty for a group that has posts. When the popular
// score cron has not (yet) populated trendingScore (fresh deploy, scheduler
// off, posts older than 30d), the trending feed must gracefully fall back to
// chronological order on the first page.

describe('PostsService.listCommunityGroupsTimelinePosts trending fallback', () => {
  function setup() {
    return makeService({
      post: {
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(),
        findFirst: jest.fn(async () => null),
      },
    });
  }

  function isTrendingFindMany(args: any): boolean {
    const first = Array.isArray(args?.orderBy) ? args.orderBy[0] : null;
    return Boolean(first && Object.prototype.hasOwnProperty.call(first, 'trendingScore'));
  }

  it('falls back to chronological order when trending returns nothing on the first page', async () => {
    const { service, deps } = setup();
    const recencyRows = [
      { id: 'p2', parentId: null, rootId: null, createdAt: new Date('2025-01-02') },
      { id: 'p1', parentId: null, rootId: null, createdAt: new Date('2025-01-01') },
    ];
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) return [];
      return recencyRows;
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 10,
      cursor: null,
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(deps.prisma.post.findMany).toHaveBeenCalledTimes(2);
    const fallbackCall = (deps.prisma.post.findMany as jest.Mock).mock.calls.find(
      (c) => !isTrendingFindMany(c[0]),
    );
    expect(fallbackCall?.[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(out.posts.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    expect(out.nextCursor).toBeNull();
  });

  it('does NOT fall back when trending returns rows', async () => {
    const { service, deps } = setup();
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) {
        return [{ id: 'p9', parentId: null, rootId: null, createdAt: new Date('2025-01-03') }];
      }
      throw new Error('chronological fallback should not run when trending has results');
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 10,
      cursor: null,
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(deps.prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(out.posts.map((p: any) => p.id)).toEqual(['p9']);
  });

  it('does NOT fall back on subsequent pages (cursor present, even if trending is empty)', async () => {
    const { service, deps } = setup();
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) return [];
      throw new Error('chronological fallback should not run when paginating');
    });
    // Cursor lookup returns a row with a real trendingScore so the cursor where is built.
    (deps.prisma.post.findFirst as jest.Mock).mockResolvedValue({
      id: 'cur',
      createdAt: new Date('2025-01-01'),
      trendingScore: 1.5,
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 10,
      cursor: 'cur',
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(deps.prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(out.posts).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });
});
