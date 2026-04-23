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

// ─── listCommunityGroupsTimelinePosts: trending blended head + chrono tail ───
// The group trending sort serves a two-phase result so the page never feels
// empty just because no posts have engagement yet:
//   1. Trending head: posts with trendingScore > 0, ordered by score then recency.
//   2. Chronological tail: when trending doesn't fill the page (fresh group,
//      sparse engagement, popular-score cron behind), supplement with the most
//      recent unscored posts. Pagination continues chronologically once the
//      cursor lands on a chrono-tail row (its trendingScore is null/0).

describe('PostsService.listCommunityGroupsTimelinePosts trending blended pagination', () => {
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

  function isChronoFindMany(args: any): boolean {
    return !isTrendingFindMany(args);
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
      (c) => isChronoFindMany(c[0]),
    );
    expect(fallbackCall?.[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(out.posts.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    // Both chrono rows fit in the page → no more chrono → no cursor.
    expect(out.nextCursor).toBeNull();
  });

  it('emits a chronological cursor when the trending fallback has more rows than fit', async () => {
    const { service, deps } = setup();
    // takeMain + 1 = 4 chrono rows for limit=3; the extra row signals "there is more."
    const recencyRows = [
      { id: 'p4', parentId: null, rootId: null, createdAt: new Date('2025-01-04'), trendingScore: null },
      { id: 'p3', parentId: null, rootId: null, createdAt: new Date('2025-01-03'), trendingScore: null },
      { id: 'p2', parentId: null, rootId: null, createdAt: new Date('2025-01-02'), trendingScore: null },
      { id: 'p1', parentId: null, rootId: null, createdAt: new Date('2025-01-01'), trendingScore: null },
    ];
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) return [];
      return recencyRows;
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 3,
      cursor: null,
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(out.posts.map((p: any) => p.id)).toEqual(['p4', 'p3', 'p2']);
    expect(out.nextCursor).toBe('p2');
  });

  it('paginates the chronological tail when the cursor row has no trendingScore', async () => {
    const { service, deps } = setup();
    (deps.prisma.post.findFirst as jest.Mock).mockResolvedValue({
      id: 'cur',
      createdAt: new Date('2025-01-05'),
      trendingScore: null,
    });
    const olderChrono = [
      { id: 'p2', parentId: null, rootId: null, createdAt: new Date('2025-01-02'), trendingScore: null },
      { id: 'p1', parentId: null, rootId: null, createdAt: new Date('2025-01-01'), trendingScore: null },
    ];
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) {
        throw new Error('fallback-mode pagination must not query the trending head again');
      }
      return olderChrono;
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 10,
      cursor: 'cur',
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(deps.prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(out.posts.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    expect(out.nextCursor).toBeNull();
  });

  it('supplements a sparse trending head with chronological fill on the first page', async () => {
    const { service, deps } = setup();
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (isTrendingFindMany(args)) {
        // One trending row, less than the page size of 3.
        return [{ id: 't1', parentId: null, rootId: null, createdAt: new Date('2025-01-10'), trendingScore: 5 }];
      }
      // Chrono fill (fillCount = 2 → take 3 to detect overflow).
      return [
        { id: 'c2', parentId: null, rootId: null, createdAt: new Date('2025-01-09'), trendingScore: null },
        { id: 'c1', parentId: null, rootId: null, createdAt: new Date('2025-01-08'), trendingScore: null },
        { id: 'c0', parentId: null, rootId: null, createdAt: new Date('2025-01-07'), trendingScore: null },
      ];
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 3,
      cursor: null,
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(out.posts.map((p: any) => p.id)).toEqual(['t1', 'c2', 'c1']);
    // Chrono had more rows than fit → cursor on the last included chrono row.
    expect(out.nextCursor).toBe('c1');

    // Verify the chrono fill query excludes posts with positive trendingScore so the
    // mode switch at the cursor boundary cannot re-show rows from the trending head.
    const chronoCall = (deps.prisma.post.findMany as jest.Mock).mock.calls.find(
      (c) => isChronoFindMany(c[0]),
    );
    const chronoAnd = chronoCall?.[0]?.where?.AND ?? [];
    const hasTrendingExclusion = chronoAnd.some(
      (clause: any) =>
        Array.isArray(clause?.OR) &&
        clause.OR.some((o: any) => o?.trendingScore === 0) &&
        clause.OR.some((o: any) => o?.trendingScore === null),
    );
    expect(hasTrendingExclusion).toBe(true);
  });

  it('paginates pure trending when the head is full', async () => {
    const { service, deps } = setup();
    (deps.prisma.post.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (!isTrendingFindMany(args)) {
        throw new Error('chronological fill must not run when trending fills the page');
      }
      // takeMain + 1 = 3 rows so the service knows there's more trending available.
      return [
        { id: 't3', parentId: null, rootId: null, createdAt: new Date('2025-01-12'), trendingScore: 9 },
        { id: 't2', parentId: null, rootId: null, createdAt: new Date('2025-01-11'), trendingScore: 7 },
        { id: 't1', parentId: null, rootId: null, createdAt: new Date('2025-01-10'), trendingScore: 5 },
      ];
    });

    const out = await service.listCommunityGroupsTimelinePosts({
      groupIds: ['g1'],
      limit: 2,
      cursor: null,
      sort: 'trending',
      applyPinnedHead: false,
    });

    expect(deps.prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(out.posts.map((p: any) => p.id)).toEqual(['t3', 't2']);
    expect(out.nextCursor).toBe('t2');
  });
});

// ─── listForYouFeed ──────────────────────────────────────────────────────────

describe('PostsService.listForYouFeed', () => {
  type ForYouCandidate = {
    id: string;
    userId: string;
    createdAt: Date;
    trendingScore: number | null;
  };

  function isTrendingScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some((c) => c?.trendingScore?.gt === 0);
  }

  function isChronoScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some(
      (c) =>
        Array.isArray(c?.OR) &&
        c.OR.some((o: any) => o?.trendingScore === 0) &&
        c.OR.some((o: any) => o?.trendingScore === null),
    );
  }

  function setupForYou(opts: {
    candidates: ForYouCandidate[];
    youFollowAuthorIds?: string[];
    followsYouAuthorIds?: string[];
    seenAtByPostId?: Record<string, Date>;
    friendReplyParentIds?: string[];
    friendBoostPostIds?: string[];
  }) {
    const candidates = opts.candidates;
    const youFollowAuthorIds = opts.youFollowAuthorIds ?? [];
    const followsYouAuthorIds = opts.followsYouAuthorIds ?? [];
    const seenAtByPostId = opts.seenAtByPostId ?? {};
    const friendReplyParentIds = opts.friendReplyParentIds ?? [];
    const friendBoostPostIds = opts.friendBoostPostIds ?? [];

    function sortTrending(a: ForYouCandidate, b: ForYouCandidate) {
      const sa = a.trendingScore ?? 0;
      const sb = b.trendingScore ?? 0;
      if (sb !== sa) return sb - sa;
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      if (bt !== at) return bt - at;
      return a.id < b.id ? 1 : -1;
    }

    function sortChrono(a: ForYouCandidate, b: ForYouCandidate) {
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      if (bt !== at) return bt - at;
      return a.id < b.id ? 1 : -1;
    }

    const post = {
      findUnique: jest.fn(),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async (args: any) => {
        if (args?.select) {
          let pool = candidates.slice();
          if (isTrendingScan(args)) {
            pool = pool.filter((c) => c.trendingScore != null && c.trendingScore > 0);
            pool.sort(sortTrending);
          } else if (isChronoScan(args)) {
            pool = pool.filter((c) => c.trendingScore == null || c.trendingScore === 0);
            pool.sort(sortChrono);
          } else {
            pool.sort(sortTrending);
          }
          if (typeof args.take === 'number') pool = pool.slice(0, args.take);
          return pool;
        }
        if (args?.include) {
          const ids: string[] = args.where?.id?.in ?? [];
          return ids.map((id) => {
            const c = candidates.find((x) => x.id === id);
            return {
              id,
              userId: c?.userId ?? 'u-unknown',
              createdAt: c?.createdAt ?? new Date(),
              trendingScore: c?.trendingScore ?? 0,
              parentId: null,
              communityGroupId: null,
              kind: 'regular',
              visibility: 'public',
              deletedAt: null,
            } as any;
          });
        }
        return [];
      }),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(),
    };

    const follow = {
      findMany: jest.fn(async (args: any) => {
        const followerId: string | undefined = args?.where?.followerId;
        const followingId: string | undefined = args?.where?.followingId;
        // Case A: viewer's outbound follows scoped to candidate authors → "you follow them"
        if (followerId && args?.where?.followingId?.in) {
          const inSet: string[] = args.where.followingId.in;
          return youFollowAuthorIds
            .filter((id) => inSet.includes(id))
            .map((id) => ({ followingId: id }));
        }
        // Case B: inbound follows scoped to candidate authors → "they follow you"
        if (followingId && args?.where?.followerId?.in) {
          const inSet: string[] = args.where.followerId.in;
          return followsYouAuthorIds
            .filter((id) => inSet.includes(id))
            .map((id) => ({ followerId: id }));
        }
        // Case C: full outbound follow list (used to compute friend-engagement set)
        if (followerId && !args?.where?.followingId) {
          return youFollowAuthorIds.map((id) => ({ followingId: id }));
        }
        return [];
      }),
    };

    const postView = {
      findMany: jest.fn(async () => {
        return Object.entries(seenAtByPostId).map(([postId, createdAt]) => ({ postId, createdAt }));
      }),
    };

    const boost = {
      findMany: jest.fn(async (args: any) => {
        const inSet: string[] = args?.where?.postId?.in ?? [];
        return friendBoostPostIds
          .filter((id) => inSet.includes(id))
          .map((id) => ({ postId: id }));
      }),
    };

    // The friend-replies query reuses post.findMany with `parentId.in` and `userId.in`.
    // Re-route that one specific shape to our friendReplyParentIds set.
    const baseFindMany = post.findMany;
    post.findMany = jest.fn(async (args: any) => {
      if (args?.where?.parentId?.in && args?.where?.userId?.in) {
        const inSet: string[] = args.where.parentId.in;
        return friendReplyParentIds
          .filter((id) => inSet.includes(id))
          .map((id) => ({ parentId: id }));
      }
      return baseFindMany(args);
    }) as any;

    const { service } = makeService(
      { post, follow, postView, boost },
      {
        viewerContext: {
          getViewer: jest.fn(async () => ({
            id: 'viewer',
            verifiedStatus: 'identity',
            premium: false,
            premiumPlus: false,
            siteAdmin: false,
            allowedPostVisibilities: ['public', 'verifiedOnly'],
          })),
          allowedPostVisibilities: jest.fn(() => ['public', 'verifiedOnly']),
          isPremium: jest.fn(() => false),
          isVerified: jest.fn(() => true),
        },
      },
    );

    return { service, post, follow, postView, boost };
  }

  function cand(id: string, userId: string, score: number | null, ageHours = 1): ForYouCandidate {
    return { id, userId, trendingScore: score, createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1000) };
  }

  it('excludes the viewer from candidate authors via the prisma where filter', async () => {
    const { service, post } = setupForYou({
      candidates: [cand('p1', 'a', 10), cand('p2', 'b', 9)],
    });

    await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });

    const selectCall = (post.findMany as jest.Mock).mock.calls.find((c) => c[0]?.select);
    // baseWhere lives inside the AND array now so the trending/chrono cursor where can be
    // appended without spread-clobbering the exclude-self filter.
    const baseAnd = selectCall?.[0]?.where?.AND?.[0] ?? {};
    expect(baseAnd?.userId).toEqual({ not: 'viewer' });
    // We deliberately do NOT filter by parentId — engaged replies are first-class trending
    // candidates and get rolled up to their root by the controller's collapseFeedByRoot.
    expect(baseAnd?.parentId).toBeUndefined();
  });

  it('intersects requestedAuthorUserIds with the exclude-self filter', async () => {
    const { service, post } = setupForYou({
      candidates: [cand('p1', 'a', 10)],
    });

    await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 10,
      cursor: null,
      visibility: 'all',
      authorUserIds: ['viewer', 'a', 'b'],
    });

    const selectCall = (post.findMany as jest.Mock).mock.calls.find((c) => c[0]?.select);
    const baseAnd = selectCall?.[0]?.where?.AND?.[0] ?? {};
    expect(baseAnd?.userId).toEqual({ in: ['a', 'b'] });
  });

  it('ranks mutual > you-follow > they-follow > stranger when raw trending is equal', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-stranger', 'u-stranger', 10, 1),
        cand('p-mutual',   'u-mutual',   10, 1),
        cand('p-follower', 'u-follower', 10, 1),
        cand('p-follow',   'u-follow',   10, 1),
      ],
      youFollowAuthorIds: ['u-mutual', 'u-follow'],
      followsYouAuthorIds: ['u-mutual', 'u-follower'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-mutual', 'p-follow', 'p-follower', 'p-stranger']);
  });

  it('penalizes posts seen recently and recovers as the seen age grows', async () => {
    const justNow = new Date();
    const aWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { service } = setupForYou({
      candidates: [
        cand('p-fresh',    'u1', 10, 1),
        cand('p-seen-old', 'u2', 10, 1),
        cand('p-seen-new', 'u3', 10, 1),
      ],
      seenAtByPostId: { 'p-seen-new': justNow, 'p-seen-old': aWeekAgo },
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-fresh', 'p-seen-old', 'p-seen-new']);
  });

  it('boosts posts where someone the viewer follows has replied or boosted', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-quiet',  'u1', 10, 1),
        cand('p-reply',  'u2', 10, 1),
        cand('p-boost',  'u3', 10, 1),
      ],
      youFollowAuthorIds: ['friend-1'],
      friendReplyParentIds: ['p-reply'],
      friendBoostPostIds: ['p-boost'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids[0] === 'p-reply' || ids[0] === 'p-boost').toBe(true);
    expect(ids[1] === 'p-reply' || ids[1] === 'p-boost').toBe(true);
    expect(ids[2]).toBe('p-quiet');
  });

  it('prefers per-author diversity in the first pass when alternates exist', async () => {
    // Populated universe: alternates exist for every cap-blocked slot, so the soft second-pass
    // never has to fire — diversity wins outright.
    const { service } = setupForYou({
      candidates: [
        cand('p1', 'hot-author', 100, 1),
        cand('p2', 'hot-author', 99, 1),
        cand('p3', 'other-a', 50, 1),
        cand('p4', 'hot-author', 40, 1),
        cand('p5', 'other-b', 30, 1),
        cand('p6', 'hot-author', 20, 1),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 4, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    // p2 blocked (immediately after hot-author at p1).
    // p3 picked (other-a).
    // p4 blocked (hot-author still inside the 3-row window: positions 0,2,3).
    // p5 picked (other-b — first appearance).
    // p6 picked (hot-author re-eligible: 3 picks since p1).
    expect(ids).toEqual(['p1', 'p3', 'p5', 'p6']);
  });

  it('softly relaxes the diversity cap when a sparse universe would otherwise return near-empty pages', async () => {
    // 5 candidates all by the same author and a small page size — strict diversity would return
    // a single row and shuffle which one as seen-decay reorders the survivors. Soft fallback
    // should fill the remaining slots in rank order so the page contains every available post,
    // making the response stable across consecutive requests.
    const { service } = setupForYou({
      candidates: [
        cand('p1', 'lone-author', 100, 1),
        cand('p2', 'lone-author', 90, 2),
        cand('p3', 'lone-author', 80, 3),
        cand('p4', 'lone-author', 70, 4),
        cand('p5', 'lone-author', 60, 5),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 30, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('emits a trending cursor when the trending head saturates the scan', async () => {
    // scanTake clamps to >= limit + 10; supply 12 trending rows so trending overflows scanTake.
    const candidates: ForYouCandidate[] = Array.from({ length: 12 }, (_, i) =>
      cand(`p${i + 1}`, `u${i + 1}`, 100 - i, 1),
    );
    const { service } = setupForYou({ candidates });
    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 1,
      cursor: null,
      visibility: 'all',
    });
    expect(out.nextCursor).not.toBeNull();
  });

  it('emits no cursor when nothing in the candidate universe overflows the scan', async () => {
    const { service } = setupForYou({ candidates: [cand('p1', 'a', 10, 1)] });
    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 10,
      cursor: null,
      visibility: 'all',
    });
    expect(out.nextCursor).toBeNull();
  });

  it('blends the trending head with the chronological tail when trending is sparse', async () => {
    // Two engaged posts and three unscored posts. With limit=5 (and scanTake clamps wide enough
    // to capture all five), the page should include both trending and the chrono tail.
    const { service, post } = setupForYou({
      candidates: [
        cand('t1', 'ut1', 50, 1),
        cand('t2', 'ut2', 40, 1),
        cand('c1', 'uc1', null, 2),
        cand('c2', 'uc2', null, 3),
        cand('c3', 'uc3', null, 4),
      ],
    });

    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 5,
      cursor: null,
      visibility: 'all',
    });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['t1', 't2', 'c1', 'c2', 'c3']));
    expect(ids.length).toBe(5);
    // Verify both prisma scans actually ran (trending head + chrono tail supplement).
    const calls = (post.findMany as jest.Mock).mock.calls.filter((c) => c[0]?.select);
    expect(calls.some((c) => isTrendingScan(c[0]))).toBe(true);
    expect(calls.some((c) => isChronoScan(c[0]))).toBe(true);
  });

  it('returns chronological-only candidates when nothing is engaged yet', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('c1', 'a', null, 1),
        cand('c2', 'b', null, 2),
        cand('c3', 'c', null, 3),
      ],
    });
    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 10,
      cursor: null,
      visibility: 'all',
    });
    expect(out.posts.map((p: any) => p.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('lets personal signals lift a chrono-tail post above an unrelated trending row', async () => {
    // Strong friend-engagement boost on a chrono row (base 1.0 * mutualFollow * friendBoost)
    // should still rank below a trending row whose base score is large — but the chrono row
    // must appear in the page (proving chrono candidates are first-class).
    const { service } = setupForYou({
      candidates: [
        cand('t-strong', 'u-stranger', 50, 1),
        cand('c-mutual-friend-boost', 'u-mutual', null, 2),
      ],
      youFollowAuthorIds: ['u-mutual'],
      followsYouAuthorIds: ['u-mutual'],
      friendBoostPostIds: ['c-mutual-friend-boost'],
    });
    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 10,
      cursor: null,
      visibility: 'all',
    });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids).toContain('c-mutual-friend-boost');
    expect(ids).toContain('t-strong');
  });

  it('returns empty when authorUserIds filter is provided but empty', async () => {
    const { service, post } = setupForYou({ candidates: [cand('p1', 'a', 10, 1)] });
    const out = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 10,
      cursor: null,
      visibility: 'all',
      authorUserIds: [],
    });
    expect(out.posts).toEqual([]);
    expect(out.nextCursor).toBeNull();
    expect(post.findMany).not.toHaveBeenCalled();
  });
});
