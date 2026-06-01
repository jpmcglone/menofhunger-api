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
    communityGroupMember: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
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
    upsertRepostNotification: jest.fn(async () => undefined),
  };
  const requestCache: any = {};
  const presenceRealtime: any = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsCommentDeleted: jest.fn(),
    emitPostsInteraction: jest.fn(),
    emitFeedNewPost: jest.fn(),
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
  const marvIdentity: any = {
    cachedMarvUserId: jest.fn(() => null),
    getMarvUserId: jest.fn(async () => null),
  };

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
    marvIdentity,
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
    deps.marvIdentity,
  );

  return { service, deps };
}

// ─── listFeed ────────────────────────────────────────────────────────────────

describe('PostsService.listFeed', () => {
  function setup(memberGroupIds: string[] = []) {
    const post = {
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(),
    };
    const communityGroupMember = {
      findMany: jest.fn(async () => memberGroupIds.map((groupId) => ({ groupId }))),
      findUnique: jest.fn(async () => null),
    };
    const follow = {
      findMany: jest.fn(async () => [{ followingId: 'followed-author' }]),
    };
    const { service, deps } = makeService(
      { post, communityGroupMember, follow },
      {
        viewerContext: {
          getViewer: jest.fn(async (viewerUserId: string | null) =>
            viewerUserId
              ? {
                  id: viewerUserId,
                  verifiedStatus: 'identity',
                  premium: false,
                  premiumPlus: false,
                  siteAdmin: false,
                  allowedPostVisibilities: ['public', 'verifiedOnly'],
                }
              : null,
          ),
          allowedPostVisibilities: jest.fn(() => ['public', 'verifiedOnly']),
          isPremium: jest.fn(() => false),
        },
      },
    );
    return { service, deps, post, communityGroupMember, follow };
  }

  async function listHomeFeed(service: PostsService, overrides: Partial<Parameters<PostsService['listFeed']>[0]> = {}) {
    await service.listFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: false,
      ...overrides,
    });
  }

  function findCommunityScope(where: any): any {
    const ands: any[] = where?.AND ?? [];
    return ands.find((part) =>
      Array.isArray(part?.OR) &&
      part.OR.some((item: any) => item?.communityGroupId === null) &&
      part.OR.some((item: any) => Array.isArray(item?.communityGroupId?.in)),
    );
  }

  function isCommunityScope(part: any): boolean {
    return Array.isArray(part?.OR) &&
      part.OR.some((item: any) => item?.communityGroupId === null) &&
      part.OR.some((item: any) => Array.isArray(item?.communityGroupId?.in));
  }

  it('includes active member-group posts in the home All chronological feed', async () => {
    const { service, post, communityGroupMember } = setup(['group-1', 'group-2']);

    await listHomeFeed(service);

    expect(communityGroupMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'viewer', status: 'active' },
      select: { groupId: true },
    });
    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect(findCommunityScope(where)).toEqual({
      OR: [
        { communityGroupId: null },
        { communityGroupId: { in: ['group-1', 'group-2'] } },
      ],
    });
  });

  it('includes followed authors inside active member groups in the home Following chronological feed', async () => {
    const { service, post } = setup(['group-1']);

    await listHomeFeed(service, { followingOnly: true });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect(findCommunityScope(where)).toEqual({
      OR: [
        { communityGroupId: null },
        { communityGroupId: { in: ['group-1'] } },
      ],
    });
    // Viewer is excluded from results; only followed authors' posts appear.
    expect((where?.AND ?? [])).toContainEqual({ NOT: { userId: 'viewer' } });
    expect((where?.AND ?? [])).toContainEqual({
      user: { followers: { some: { followerId: 'viewer' } } },
    });
    expect((where?.AND ?? [])).not.toContainEqual({
      OR: [
        { userId: 'viewer' },
        { user: { followers: { some: { followerId: 'viewer' } } } },
      ],
    });
  });

  it('keeps author-filtered chronological feeds global-only', async () => {
    const { service, post, communityGroupMember } = setup(['group-1']);

    await listHomeFeed(service, { authorUserIds: ['author-1'] });

    expect(communityGroupMember.findMany).not.toHaveBeenCalled();
    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect(where?.AND ?? []).toContainEqual({ communityGroupId: null });
  });

  it('includes active member-group posts in the home All trending feed', async () => {
    const { service, post, communityGroupMember } = setup(['group-1', 'group-2']);

    await service.listPopularFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: false,
    });

    expect(communityGroupMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'viewer', status: 'active' },
      select: { groupId: true },
    });
    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    const communityScope = (where?.AND ?? []).find(isCommunityScope);
    expect(communityScope).toBeTruthy();
    expect(communityScope.OR[1]).toEqual({ communityGroupId: { in: ['group-1', 'group-2'] } });
  });

  it('includes followed authors inside active member groups in the home Following trending feed', async () => {
    const { service, post } = setup(['group-1']);

    await service.listPopularFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: true,
    });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? []).some(isCommunityScope)).toBe(true);
    // Viewer is excluded from the author scope — only followed authors' posts appear.
    expect(where?.AND ?? []).toContainEqual({ userId: { in: ['followed-author'] } });
    expect(where?.AND ?? []).not.toContainEqual({ userId: { in: ['viewer', 'followed-author'] } });
  });

  it('keeps author-filtered trending feeds global-only', async () => {
    const { service, post, communityGroupMember } = setup(['group-1']);

    await service.listPopularFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: false,
      authorUserIds: ['author-1'],
    });

    expect(communityGroupMember.findMany).not.toHaveBeenCalled();
    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect(where?.AND ?? []).toContainEqual({ communityGroupId: null });
  });

  it('excludes the viewer from the home All chronological feed', async () => {
    const { service, post } = setup();

    await listHomeFeed(service, { followingOnly: false });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? [])).toContainEqual({ NOT: { userId: 'viewer' } });
  });

  it('excludes the viewer from the home Following chronological feed', async () => {
    const { service, post } = setup();

    await listHomeFeed(service, { followingOnly: true });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? [])).toContainEqual({ NOT: { userId: 'viewer' } });
  });

  it('does NOT exclude the viewer from author-scoped chronological feeds', async () => {
    const { service, post } = setup();

    await listHomeFeed(service, { authorUserIds: ['viewer'] });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? [])).not.toContainEqual({ NOT: { userId: 'viewer' } });
  });

  it('excludes the viewer from the home All trending feed', async () => {
    const { service, post } = setup();

    await service.listPopularFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: false,
    });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? [])).toContainEqual({ NOT: { userId: 'viewer' } });
  });

  it('does NOT exclude the viewer from author-scoped trending feeds', async () => {
    const { service, post } = setup();

    await service.listPopularFeed({
      viewerUserId: 'viewer',
      limit: 30,
      cursor: null,
      visibility: 'all',
      followingOnly: false,
      authorUserIds: ['viewer'],
    });

    const where = (post.findMany as jest.Mock).mock.calls[0]?.[0]?.where;
    expect((where?.AND ?? [])).not.toContainEqual({ NOT: { userId: 'viewer' } });
  });
});

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

  it('repostPost preserves the canonical post group scope when the actor is an active member', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    deps.prisma.post.findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'canonical-1',
        userId: 'author',
        visibility: 'public',
        kind: 'regular',
        repostedPostId: null,
        communityGroupId: 'group-1',
      })
      .mockResolvedValueOnce(null);
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    deps.prisma.communityGroupMember.findUnique = jest.fn(async () => ({ status: 'active' }));
    const create = jest.fn(async () => ({ id: 'repost-1' }));
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      const tx: any = { post: { create, update: jest.fn(async () => ({ repostCount: 3 })) } };
      return fn(tx);
    });
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    deps.notifications.upsertRepostNotification = jest.fn(async () => undefined);
    deps.postViews.markViewed = jest.fn(async () => undefined);

    await service.repostPost({ userId: 'u1', postId: 'canonical-1' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'repost', communityGroupId: 'group-1' }),
      }),
    );
  });

  it('repostPost pushes the new repost to the group feed room when the canonical post is in a group', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    deps.prisma.post.findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'canonical-1',
        userId: 'author',
        visibility: 'public',
        kind: 'regular',
        repostedPostId: null,
        communityGroupId: 'group-1',
      })
      .mockResolvedValueOnce(null);
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    deps.prisma.communityGroupMember.findUnique = jest.fn(async () => ({ status: 'active' }));
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      const tx: any = {
        post: {
          create: jest.fn(async () => ({ id: 'repost-1' })),
          update: jest.fn(async () => ({ repostCount: 4 })),
        },
      };
      return fn(tx);
    });
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    deps.notifications.upsertRepostNotification = jest.fn(async () => undefined);
    deps.postViews.markViewed = jest.fn(async () => undefined);
    // Decouple from DTO assembly internals — assert the group emit is wired.
    const emitSpy = jest
      .spyOn(service as any, 'emitGroupRepostCreated')
      .mockResolvedValue(undefined);

    await service.repostPost({ userId: 'u1', postId: 'canonical-1' });

    expect(emitSpy).toHaveBeenCalledWith('group-1', 'repost-1', 'canonical-1');
  });

  it('repostPost does NOT push to a group feed room for a non-group repost', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    deps.prisma.post.findFirst = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'canonical-1',
        userId: 'author',
        visibility: 'public',
        kind: 'regular',
        repostedPostId: null,
        communityGroupId: null,
      })
      .mockResolvedValueOnce(null);
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    deps.prisma.$transaction = jest.fn(async (fn: any) => {
      const tx: any = {
        post: {
          create: jest.fn(async () => ({ id: 'repost-1' })),
          update: jest.fn(async () => ({ repostCount: 4 })),
        },
      };
      return fn(tx);
    });
    deps.cacheInvalidation.bumpFeedGlobal = jest.fn(async () => undefined);
    deps.notifications.upsertRepostNotification = jest.fn(async () => undefined);
    deps.postViews.markViewed = jest.fn(async () => undefined);
    const emitSpy = jest
      .spyOn(service as any, 'emitGroupRepostCreated')
      .mockResolvedValue(undefined);

    await service.repostPost({ userId: 'u1', postId: 'canonical-1' });

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('repostPost throws when the canonical post is in a group the actor has not joined', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique = jest.fn(async () => ({
      id: 'u1',
      usernameIsSet: true,
      verifiedStatus: 'verified',
    }));
    deps.prisma.post.findFirst = jest.fn().mockResolvedValueOnce({
      id: 'canonical-1',
      userId: 'author',
      visibility: 'public',
      kind: 'regular',
      repostedPostId: null,
      communityGroupId: 'group-1',
    });
    deps.prisma.userBlock = { count: jest.fn(async () => 0) };
    deps.prisma.communityGroupMember.findUnique = jest.fn(async () => null);

    await expect(service.repostPost({ userId: 'u1', postId: 'canonical-1' })).rejects.toBeInstanceOf(
      ForbiddenException,
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

// ─── runPostCreateSideEffects: group post notification membership gating ─────

describe('PostsService.runPostCreateSideEffects — group notification gating', () => {
  function setup(activeMemberIds: string[] = []) {
    const { service, deps } = makeService();
    deps.prisma.communityGroup = { findUnique: jest.fn() };
    deps.prisma.communityGroupMember = {
      findMany: jest.fn(async (args: any) => {
        const ids: string[] = args?.where?.userId?.in ?? [];
        return activeMemberIds.filter((id) => ids.includes(id)).map((userId) => ({ userId }));
      }),
    };
    deps.prisma.follow = { findMany: jest.fn(async () => []) };
    return { service, deps };
  }

  function basePost(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'post-1',
      userId: 'author',
      body: 'hello',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      editedAt: null,
      editCount: 0,
      deletedAt: null,
      kind: 'regular',
      checkinDayKey: null,
      checkinPrompt: null,
      visibility: 'public',
      isDraft: false,
      topics: [],
      hashtags: [],
      boostCount: 0,
      bookmarkCount: 0,
      commentCount: 0,
      repostCount: 0,
      viewerCount: 0,
      parentId: null,
      communityGroupId: 'g1',
      pinnedInGroupAt: null,
      media: [],
      mentions: [],
      poll: null,
      user: {
        id: 'author',
        username: 'author',
        name: 'Author',
        premium: false,
        premiumPlus: false,
        isOrganization: false,
        stewardBadgeEnabled: false,
        verifiedStatus: 'identity',
        avatarKey: null,
        avatarUpdatedAt: null,
        orgMemberships: [],
        bannedAt: null,
      },
      ...overrides,
    } as any;
  }

  async function callSideEffects(service: PostsService, args: any): Promise<void> {
    await (service as any).runPostCreateSideEffects({
      actorUserId: 'author',
      post: basePost(args.postOverrides),
      parentId: args.parentId ?? null,
      parentAuthorUserId: args.parentAuthorUserId ?? null,
      threadPostsForRoles: args.threadPostsForRoles ?? [],
      bodyMentionIds: args.bodyMentionIds ?? [],
      bodyMentionSet: new Set(args.bodyMentionSet ?? args.bodyMentionIds ?? []),
      bodySnippet: '',
      visibility: args.visibility ?? 'public',
      quotedInfo: args.quotedInfo ?? null,
      didAwardStreak: false,
    });
  }

  it('creates followed_post notifications and feed inserts only for active members of the post group', async () => {
    const { service, deps } = setup(['member-follower']);
    deps.prisma.follow.findMany.mockResolvedValue([
      { followerId: 'member-follower', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
      { followerId: 'outside-follower', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
    ]);

    await callSideEffects(service, {
      postOverrides: { communityGroupId: 'g1' },
    });

    const followedPostCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'followed_post',
    );
    expect(followedPostCalls.map((c) => c[0].recipientUserId)).toEqual(['member-follower']);
    expect(deps.presenceRealtime.emitFeedNewPost).toHaveBeenCalledWith(
      ['member-follower'],
      expect.objectContaining({ post: expect.objectContaining({ id: 'post-1' }) }),
    );
  });

  it('suppresses reply notifications for non-members of the post group', async () => {
    const { service, deps } = setup(['parent-member', 'thread-member']);

    await callSideEffects(service, {
      parentId: 'parent-1',
      parentAuthorUserId: 'parent-member',
      threadPostsForRoles: [
        {
          id: 'parent-1',
          parentId: null,
          userId: 'parent-member',
          mentions: [{ userId: 'thread-member' }, { userId: 'outside-thread-user' }],
        },
      ],
      postOverrides: { communityGroupId: 'g1' },
    });

    const commentCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'comment',
    );
    expect(commentCalls.map((c) => c[0].recipientUserId)).toEqual(['parent-member', 'thread-member']);
  });

  it('suppresses quote notifications for non-members of the post group', async () => {
    const { service, deps } = setup([]);

    await callSideEffects(service, {
      quotedInfo: { quotedAuthorId: 'quoted-author', quotedPostId: 'quoted-post' },
      postOverrides: { communityGroupId: 'g1' },
    });

    expect(deps.notifications.upsertRepostNotification).not.toHaveBeenCalled();
  });

  it('allows non-member mentions only for public posts in open groups', async () => {
    const { service, deps } = setup([]);
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(service, {
      bodyMentionIds: ['outside-mentioned'],
      visibility: 'public',
      postOverrides: { communityGroupId: 'g1', visibility: 'public' },
    });

    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls.map((c) => c[0].recipientUserId)).toEqual(['outside-mentioned']);
    expect(deps.prisma.communityGroupMember.findMany).not.toHaveBeenCalled();
  });

  it('suppresses non-member mentions in open groups when the post is not public', async () => {
    const { service, deps } = setup([]);
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(service, {
      bodyMentionIds: ['outside-mentioned'],
      visibility: 'verifiedOnly',
      postOverrides: { communityGroupId: 'g1', visibility: 'verifiedOnly' },
    });

    const mentionCalls = (deps.notifications.create as jest.Mock).mock.calls.filter(
      (c) => c[0]?.kind === 'mention',
    );
    expect(mentionCalls).toHaveLength(0);
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
    parentId: string | null;
    communityGroupId: string | null;
    createdAt: Date;
    trendingScore: number | null;
  };

  type SeenFixture = Date | { createdAt?: Date; lastSeenAt?: Date; seenCount?: number; lastSource?: string | null };

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

  function isFollowedUnseenScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some((c) => Array.isArray(c?.userId?.in)) &&
      ands.some((c) => c?.views?.none?.userId === 'viewer');
  }

  function isFriendEngagedScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some(
      (c) =>
        Array.isArray(c?.OR) &&
        c.OR.some((o: any) => o?.boosts?.some?.userId?.in) &&
        c.OR.some((o: any) => o?.replies?.some?.userId?.in),
    );
  }

  function isSecondDegreeScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some((c) => Array.isArray(c?.userId?.in)) &&
      ands.some((c) => c?.createdAt?.gte instanceof Date) &&
      !ands.some((c) => c?.communityGroupId) &&
      !ands.some((c) => c?.views?.none?.userId === 'viewer') &&
      !isFriendEngagedScan(args);
  }

  function isMemberGroupScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some((c) => Array.isArray(c?.communityGroupId?.in));
  }

  function isOpenFollowGroupScan(args: any): boolean {
    const ands: any[] = args?.where?.AND ?? [];
    return ands.some((c) => c?.communityGroup?.is?.joinPolicy === 'open');
  }

  function excludedIds(args: any): Set<string> {
    const ands: any[] = args?.where?.AND ?? [];
    const ids = ands.flatMap((c) => Array.isArray(c?.id?.notIn) ? c.id.notIn : []);
    return new Set(ids);
  }

  function applyBaseAuthorFilter(args: any, pool: ForYouCandidate[]): ForYouCandidate[] {
    const base = args?.where?.AND?.[0] ?? {};
    const userId = base?.userId;
    const communityGroupId = base?.communityGroupId;
    if (communityGroupId === null) pool = pool.filter((c) => c.communityGroupId == null);
    if (Array.isArray(userId?.in)) return pool.filter((c) => userId.in.includes(c.userId));
    if (Array.isArray(userId?.notIn)) return pool.filter((c) => !userId.notIn.includes(c.userId));
    if (typeof userId?.not === 'string') return pool.filter((c) => c.userId !== userId.not);
    return pool;
  }

  function setupForYou(opts: {
    candidates: ForYouCandidate[];
    youFollowAuthorIds?: string[];
    followsYouAuthorIds?: string[];
    seenAtByPostId?: Record<string, SeenFixture>;
    friendReplyParentIds?: string[];
    friendBoostPostIds?: string[];
    /**
     * When set, the friend-engagement timestamp lookup (used to give old posts a recent-engagement
     * "effective age") returns these dates. Keyed by postId. Posts without an entry fall back to
     * their own createdAt (i.e. no engagement-driven freshness).
     */
    friendEngagementAtByPostId?: Record<string, Date>;
    secondDegreeEdges?: Array<{ followerId: string; followingId: string }>;
    blockedAuthorIds?: string[];
    memberGroupIds?: string[];
    viewerVerified?: boolean;
    /** Author IDs the viewer has recently boosted (A+ tier engagement history). */
    viewerBoostedAuthorIds?: string[];
    /** Author IDs of posts the viewer has recently replied to (A+ tier engagement history). */
    viewerRepliedToAuthorIds?: string[];
  }) {
    const candidates = opts.candidates;
    const youFollowAuthorIds = opts.youFollowAuthorIds ?? [];
    const followsYouAuthorIds = opts.followsYouAuthorIds ?? [];
    const seenAtByPostId = opts.seenAtByPostId ?? {};
    const friendReplyParentIds = opts.friendReplyParentIds ?? [];
    const friendBoostPostIds = opts.friendBoostPostIds ?? [];
    const friendEngagementAtByPostId = opts.friendEngagementAtByPostId ?? {};
    const secondDegreeEdges = opts.secondDegreeEdges ?? [];
    const blockedAuthorIds = opts.blockedAuthorIds ?? [];
    const memberGroupIds = opts.memberGroupIds ?? [];
    const viewerVerified = opts.viewerVerified ?? true;
    const viewerBoostedAuthorIds = opts.viewerBoostedAuthorIds ?? [];
    const viewerRepliedToAuthorIds = opts.viewerRepliedToAuthorIds ?? [];

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
      groupBy: jest.fn(async (args: any) => {
        // The For You ranker groups replies by parentId to find the latest reply + count by anyone
        // the viewer follows. Mirror that exact shape here including _count.
        if (Array.isArray(args?.by) && args.by.includes('parentId')) {
          const inSet: string[] = args?.where?.parentId?.in ?? [];
          return friendReplyParentIds
            .filter((id) => inSet.includes(id))
            .filter((id) => friendEngagementAtByPostId[id] != null)
            .map((id) => ({ parentId: id, _max: { createdAt: friendEngagementAtByPostId[id] }, _count: { userId: 1 } }));
        }
        return [];
      }),
      findMany: jest.fn(async (args: any) => {
        if (args?.select) {
          let pool = candidates.slice();
          pool = applyBaseAuthorFilter(args, pool);
          const notIn = excludedIds(args);
          if (notIn.size > 0) pool = pool.filter((c) => !notIn.has(c.id));

          if (isFollowedUnseenScan(args)) {
            const followedIds: string[] = (args?.where?.AND ?? []).find((c: any) => Array.isArray(c?.userId?.in))?.userId?.in ?? [];
            pool = pool.filter((c) => followedIds.includes(c.userId) && !seenAtByPostId[c.id]);
            pool.sort(sortChrono);
          } else if (isFriendEngagedScan(args)) {
            const engaged = new Set([...friendReplyParentIds, ...friendBoostPostIds]);
            pool = pool.filter((c) => engaged.has(c.id));
            pool.sort(sortChrono);
          } else if (isMemberGroupScan(args)) {
            const groupIds: string[] = (args?.where?.AND ?? []).find((c: any) => Array.isArray(c?.communityGroupId?.in))?.communityGroupId?.in ?? [];
            pool = pool.filter((c) => c.communityGroupId != null && groupIds.includes(c.communityGroupId));
            pool.sort(sortTrending);
          } else if (isOpenFollowGroupScan(args)) {
            const authorIds: string[] = (args?.where?.AND ?? []).find((c: any) => Array.isArray(c?.userId?.in))?.userId?.in ?? [];
            const notInGroups: string[] = (args?.where?.AND ?? []).find((c: any) => Array.isArray(c?.communityGroupId?.notIn))?.communityGroupId?.notIn ?? [];
            pool = pool.filter((c) => c.communityGroupId != null && authorIds.includes(c.userId) && !notInGroups.includes(c.communityGroupId));
            pool.sort(sortTrending);
          } else if (isSecondDegreeScan(args)) {
            const authorIds: string[] = (args?.where?.AND ?? []).find((c: any) => Array.isArray(c?.userId?.in))?.userId?.in ?? [];
            pool = pool.filter((c) => authorIds.includes(c.userId));
            pool.sort(sortTrending);
          } else if (isTrendingScan(args)) {
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
              parentId: c?.parentId ?? null,
              communityGroupId: c?.communityGroupId ?? null,
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
        if (Array.isArray(args?.where?.followerId?.in) && typeof args?.where?.followingId !== 'string') {
          const followerIds: string[] = args.where.followerId.in;
          const followingIn: string[] | undefined = args?.where?.followingId?.in;
          const followingNotIn: string[] = args?.where?.followingId?.notIn ?? [];
          return secondDegreeEdges
            .filter((edge) => followerIds.includes(edge.followerId))
            .filter((edge) => !followingIn || followingIn.includes(edge.followingId))
            .filter((edge) => !followingNotIn.includes(edge.followingId))
            .map((edge) => ({ followingId: edge.followingId }));
        }
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
        return Object.entries(seenAtByPostId).map(([postId, value]) => {
          const seen = value instanceof Date ? { createdAt: value, lastSeenAt: value } : value;
          const createdAt = seen.createdAt ?? seen.lastSeenAt ?? new Date();
          return {
            postId,
            createdAt,
            lastSeenAt: seen.lastSeenAt ?? createdAt,
            seenCount: seen.seenCount ?? 1,
            lastSource: seen.lastSource ?? null,
          };
        });
      }),
    };

    const boost = {
      findMany: jest.fn(async (args: any) => {
        // Viewer's own engagement history (A+ tier): returns author IDs of boosted posts.
        if (args?.where?.userId === 'viewer') {
          return viewerBoostedAuthorIds.map((authorId) => ({ post: { userId: authorId } }));
        }
        const inSet: string[] = args?.where?.postId?.in ?? [];
        return friendBoostPostIds
          .filter((id) => inSet.includes(id))
          .map((id) => ({ postId: id }));
      }),
      groupBy: jest.fn(async (args: any) => {
        // The For You ranker groups boosts by postId for friend-engaged candidates only.
        if (Array.isArray(args?.by) && args.by.includes('postId')) {
          const inSet: string[] = args?.where?.postId?.in ?? [];
          return friendBoostPostIds
            .filter((id) => inSet.includes(id))
            .filter((id) => friendEngagementAtByPostId[id] != null)
            .map((id) => ({ postId: id, _max: { createdAt: friendEngagementAtByPostId[id] }, _count: { userId: 1 } }));
        }
        return [];
      }),
    };

    // Re-route special post.findMany shapes that the For You ranker uses for supplementary lookups.
    const baseFindMany = post.findMany;
    post.findMany = jest.fn(async (args: any) => {
      // Viewer's own recent replies (A+ tier engagement history): `parentId.not` means top-level only
      // is NOT requested, and userId is the viewer.
      if (args?.where?.userId === 'viewer' && args?.where?.parentId?.not === null) {
        return viewerRepliedToAuthorIds.map((authorId) => ({ parent: { userId: authorId } }));
      }
      // Friend-replies: parentId.in + userId.in scoped to following set.
      if (args?.where?.parentId?.in && args?.where?.userId?.in) {
        const inSet: string[] = args.where.parentId.in;
        return friendReplyParentIds
          .filter((id) => inSet.includes(id))
          .map((id) => ({ parentId: id }));
      }
      return baseFindMany(args);
    }) as any;

    const { service } = makeService(
      {
        post,
        follow,
        postView,
        boost,
        userBlock: {
          findMany: jest.fn(async () => blockedAuthorIds.map((blockedId) => ({ blockerId: 'viewer', blockedId }))),
        },
        communityGroupMember: {
          findMany: jest.fn(async () => memberGroupIds.map((groupId) => ({ groupId }))),
        },
      },
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
          isVerified: jest.fn(() => viewerVerified),
        },
        redis: {
          getJson: jest.fn(async () => null),
          setJson: jest.fn(async () => undefined),
          del: jest.fn(async () => undefined),
        },
      },
    );

    return { service, post, follow, postView, boost };
  }

  function cand(id: string, userId: string, score: number | null, ageHours = 1): ForYouCandidate {
    return { id, userId, parentId: null, communityGroupId: null, trendingScore: score, createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1000) };
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

  it('ranks friend-engaged-stranger post (E tier) between you-follow (B) and they-follow (C) tiers', async () => {
    // Three posts with identical trendingScore and age. The only signal is the author relationship:
    //   B — viewer follows the author (relMult = 1.1, no friend engagement)
    //   E — viewer doesn't follow author, but someone they follow engaged (relMult = 0.85)
    //   C — author follows viewer, no friend engagement (relMult = 0.65)
    // Expected order: B > E > C (A > B > E > C > D is the full tier hierarchy).
    const { service } = setupForYou({
      candidates: [
        cand('p-b-follow',      'u-follow',   10, 1),
        cand('p-e-friend',      'u-stranger', 10, 1),
        cand('p-c-follower',    'u-follower', 10, 1),
      ],
      youFollowAuthorIds: ['u-follow', 'friend-1'],
      followsYouAuthorIds: ['u-follower'],
      friendBoostPostIds: ['p-e-friend'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-b-follow', 'p-e-friend', 'p-c-follower']);
  });

  it('puts recent unseen followed posts ahead of unrelated trending on page one', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-unrelated-hot', 'u-stranger', 100, 1),
        cand('p-followed-new', 'u-follow', null, 1),
        cand('p-other', 'u-other', 8, 1),
      ],
      youFollowAuthorIds: ['u-follow'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 3, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)[0]).toBe('p-followed-new');
  });

  it('puts a brand-new unseen mutual-follow post at the top, even when older followed posts have much higher trendingScore', async () => {
    // Reproduces the reported regression: viewer (A) follows several active users; user B (a
    // mutual follow) posts something a minute ago, but every other followed author has an older
    // post with a fat trendingScore. Because the new post has trendingScore=null, its `adjusted`
    // score lands well below the older posts. Picking the followed-unseen quota by `adjusted`
    // would bury the new post — A would refresh For You and not see B's new post anywhere.
    // The quota must be ordered by recency so the freshest follow post wins the "tippy top" slot.
    const { service } = setupForYou({
      candidates: [
        cand('p-fresh-mutual', 'u-fresh-mutual', null, 1 / 60),
        cand('p-old-popular-1', 'u-pop-a', 500, 24),
        cand('p-old-popular-2', 'u-pop-b', 400, 30),
        cand('p-old-popular-3', 'u-pop-c', 300, 36),
      ],
      youFollowAuthorIds: ['u-fresh-mutual', 'u-pop-a', 'u-pop-b', 'u-pop-c'],
      followsYouAuthorIds: ['u-fresh-mutual'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 5, cursor: null, visibility: 'all' });
    expect(out.posts[0]?.id).toBe('p-fresh-mutual');
  });

  it('prefers a mutual-follow post over a one-way-follow post when both are in the same recency tier', async () => {
    // Within a 2h freshness tier, mutual follows beat one-way follows — the user explicitly
    // asked for mutuals to sit higher at the top. Outside the tier (older), recency wins.
    const { service } = setupForYou({
      candidates: [
        cand('p-one-way', 'u-one-way', null, 0.25),
        cand('p-mutual', 'u-mutual', null, 0.75),
      ],
      youFollowAuthorIds: ['u-mutual', 'u-one-way'],
      followsYouAuthorIds: ['u-mutual'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 5, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id).slice(0, 2)).toEqual(['p-mutual', 'p-one-way']);
  });

  it('keeps unseen followed posts above recently seen followed posts', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-followed-seen', 'u-follow', 50, 1),
        cand('p-followed-unseen', 'u-follow', null, 2),
        cand('p-stranger', 'u-stranger', 20, 1),
      ],
      youFollowAuthorIds: ['u-follow'],
      seenAtByPostId: { 'p-followed-seen': new Date() },
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 3, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids.indexOf('p-followed-unseen')).toBeLessThan(ids.indexOf('p-followed-seen'));
  });

  it('sources friend-engaged discovery even when the post is absent from the trending scan', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-trending', 'u-stranger', 20, 1),
        cand('p-friend-boosted-quiet', 'u-quiet', null, 2),
      ],
      youFollowAuthorIds: ['friend-1'],
      friendBoostPostIds: ['p-friend-boosted-quiet'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 5, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toContain('p-friend-boosted-quiet');
  });

  it('lets friend-engaged quiet posts beat weak generic trending', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-generic-trending', 'u-stranger', 10, 1),
        cand('p-friend-boosted-quiet', 'u-quiet', null, 1),
      ],
      youFollowAuthorIds: ['friend-1'],
      friendBoostPostIds: ['p-friend-boosted-quiet'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-friend-boosted-quiet', 'p-generic-trending']);
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

  it('gives newer posts a strong edge over a slightly-higher older post', async () => {
    // Under the recency formula, a 1h-old post with `trendingScore=10` clobbers a 72h-old post
    // with `trendingScore=11`. The recency multiplier collapses by ~5x between 1h and 72h, so a
    // marginally higher older score can't win — only a meaningfully bigger one can (covered in
    // the dedicated "blockbuster" test below).
    const { service } = setupForYou({
      candidates: [
        cand('p-older-slightly-higher', 'u-old', 11, 72),
        cand('p-newer-slightly-lower', 'u-new', 10, 1),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-newer-slightly-lower', 'p-older-slightly-higher']);
  });

  it('orders posts strictly by recency when trending and relationship are equal (24h > 48h > 72h)', async () => {
    // All three posts have identical `trendingScore` and stranger relationship. The only signal
    // left is post age, so the result must be strictly newest-first across the 24h/48h/72h
    // buckets the user described.
    const { service } = setupForYou({
      candidates: [
        cand('p-12h', 'u-a', 50, 12),
        cand('p-36h', 'u-b', 50, 36),
        cand('p-60h', 'u-c', 50, 60),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-12h', 'p-36h', 'p-60h']);
  });

  it('lets a high-trending 72h post still beat a moderately-trending 6h post', async () => {
    // The user's explicit requirement: a *really* popular older post can still rank above a
    // fresher post. Engagement has to be much higher (~5x), but it's not impossible — the floor
    // on the recency multiplier is non-zero on purpose.
    const { service } = setupForYou({
      candidates: [
        cand('p-blockbuster-72h', 'u-old', 100, 72),
        cand('p-fresh-modest', 'u-new', 20, 6),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-blockbuster-72h', 'p-fresh-modest']);
  });

  it('uses the latest friend-engagement timestamp as effective age for friend-engaged posts', async () => {
    // A 30-day-old post with a 2h-ago reply from someone the viewer follows should rank like
    // fresh content — that's the user's "older posts that have RECENT replies by people you
    // follow can also be scored up a bit" requirement. Without engagement-based recency this
    // post would be hammered to ~floor by its 30-day age.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { service } = setupForYou({
      candidates: [
        cand('p-old-friend-replied', 'u-old', 10, 24 * 30),
        cand('p-fresh-stranger', 'u-stranger', 10, 24),
      ],
      youFollowAuthorIds: ['friend-1'],
      friendReplyParentIds: ['p-old-friend-replied'],
      friendEngagementAtByPostId: { 'p-old-friend-replied': twoHoursAgo },
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-old-friend-replied', 'p-fresh-stranger']);
  });

  it('uses lastSeenAt, not first createdAt, so refreshes suppress posts seen again moments ago', async () => {
    const firstSeenAWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const justNow = new Date();
    const { service } = setupForYou({
      candidates: [
        cand('p-unseen', 'u1', 10, 1),
        cand('p-repeat-seen', 'u2', 10, 1),
      ],
      seenAtByPostId: {
        'p-repeat-seen': {
          createdAt: firstSeenAWeekAgo,
          lastSeenAt: justNow,
          seenCount: 3,
          lastSource: 'feed_scroll',
        },
      },
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-unseen', 'p-repeat-seen']);
  });

  it('surfaces second-degree authors below direct social content but above equal-score strangers', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-direct-follow', 'u-direct', 20, 1),
        cand('p-second-degree', 'u-second', 20, 1),
        cand('p-stranger', 'u-stranger', 20, 1),
      ],
      youFollowAuthorIds: ['u-direct', 'friend-1'],
      secondDegreeEdges: [{ followerId: 'friend-1', followingId: 'u-second' }],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-direct-follow', 'p-second-degree', 'p-stranger']);
  });

  it('mixes readable member-group posts into For You using relationship scoring', async () => {
    const memberGroupPost = cand('p-member-group', 'u-group-follow', 10, 1);
    memberGroupPost.communityGroupId = 'g-member';
    const { service } = setupForYou({
      candidates: [
        cand('p-direct-follow', 'u-direct-follow', 10, 1),
        memberGroupPost,
        cand('p-stranger', 'u-stranger', 10, 1),
      ],
      youFollowAuthorIds: ['u-direct-follow', 'u-group-follow'],
      memberGroupIds: ['g-member'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-direct-follow', 'p-member-group', 'p-stranger']);
  });

  it('orders member-group posts by mutual, following, follower, then stranger relationship', async () => {
    const mutual = cand('p-group-mutual', 'u-mutual', 10, 1);
    const following = cand('p-group-following', 'u-following', 10, 1);
    const follower = cand('p-group-follower', 'u-follower', 10, 1);
    const stranger = cand('p-group-stranger', 'u-stranger', 10, 1);
    for (const post of [mutual, following, follower, stranger]) {
      post.communityGroupId = 'g-member';
    }
    const { service } = setupForYou({
      candidates: [stranger, mutual, follower, following],
      youFollowAuthorIds: ['u-mutual', 'u-following'],
      followsYouAuthorIds: ['u-mutual', 'u-follower'],
      memberGroupIds: ['g-member'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual([
      'p-group-mutual',
      'p-group-following',
      'p-group-follower',
      'p-group-stranger',
    ]);
  });

  it('mixes open-group posts by followed authors only for verified viewers', async () => {
    const openGroupPost = cand('p-open-group-follow', 'u-follow', 10, 1);
    openGroupPost.communityGroupId = 'g-open';
    const { service } = setupForYou({
      candidates: [
        openGroupPost,
        cand('p-stranger', 'u-stranger', 10, 1),
      ],
      youFollowAuthorIds: ['u-follow'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-open-group-follow', 'p-stranger']);
  });

  it('downranks open-group followed-author posts below comparable non-group direct follows', async () => {
    const openGroupPost = cand('p-open-group-follow', 'u-group-follow', 10, 1);
    openGroupPost.communityGroupId = 'g-open';
    const { service } = setupForYou({
      candidates: [
        cand('p-direct-follow', 'u-direct-follow', 10, 1),
        openGroupPost,
        cand('p-stranger', 'u-stranger', 10, 1),
      ],
      youFollowAuthorIds: ['u-direct-follow', 'u-group-follow'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-direct-follow', 'p-open-group-follow', 'p-stranger']);
  });

  it('does not include open-group followed-author posts for unverified viewers', async () => {
    const openGroupPost = cand('p-open-group-follow', 'u-follow', 10, 1);
    openGroupPost.communityGroupId = 'g-open';
    const { service } = setupForYou({
      candidates: [
        openGroupPost,
        cand('p-stranger', 'u-stranger', 10, 1),
      ],
      youFollowAuthorIds: ['u-follow'],
      viewerVerified: false,
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-stranger']);
  });

  it('excludes blocked authors before ranking so they do not consume For You slots', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p-blocked-hot', 'u-blocked', 100, 1),
        cand('p-allowed', 'u-allowed', 10, 1),
      ],
      blockedAuthorIds: ['u-blocked'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-allowed']);
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
    // Populated universe with 4 unique authors: alternates exist for every cap-blocked slot, so
    // the soft second-pass never has to fire — diversity wins outright across a 4-row page.
    const { service } = setupForYou({
      candidates: [
        cand('p1', 'hot-author', 100, 1),
        cand('p2', 'hot-author', 99, 1),
        cand('p3', 'other-a', 50, 1),
        cand('p4', 'hot-author', 40, 1),
        cand('p5', 'other-b', 30, 1),
        cand('p6', 'hot-author', 20, 1),
        cand('p7', 'other-c', 15, 1),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 4, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    // p2 blocked (hot-author already at p1).
    // p3 picked (other-a — first appearance).
    // p4 blocked (hot-author still inside the 5-row window).
    // p5 picked (other-b — first appearance).
    // p6 blocked (hot-author still inside the 5-row window).
    // p7 picked (other-c — first appearance fills the 4th slot).
    expect(ids).toEqual(['p1', 'p3', 'p5', 'p7']);
  });

  it('keeps a single author from clustering across the 5-row diversity window', async () => {
    // u-prolific authors most of the candidate pool; with `forYouMaxPerAuthorWindow = 5`, only
    // ONE u-prolific post should appear in any 5-pick window — and the page should be filled
    // with filler authors instead. Under the previous window=3, two u-prolific posts could
    // share the same 5-row window; under window=5, they cannot.
    const { service } = setupForYou({
      candidates: [
        cand('p1', 'u-prolific', 100, 1),
        cand('p2', 'u-prolific', 95, 1),
        cand('p-a', 'u-a', 90, 1),
        cand('p3', 'u-prolific', 85, 1),
        cand('p-b', 'u-b', 80, 1),
        cand('p4', 'u-prolific', 75, 1),
        cand('p-c', 'u-c', 70, 1),
        cand('p5', 'u-prolific', 65, 1),
        cand('p-d', 'u-d', 60, 1),
        cand('p-e', 'u-e', 55, 1),
        cand('p-f', 'u-f', 50, 1),
      ],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 6, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    // First-pass picks the highest-scored u-prolific (p1) then walks past every subsequent
    // u-prolific candidate inside the 5-row window, picking fillers instead until the page is
    // full at 6.
    expect(ids).toEqual(['p1', 'p-a', 'p-b', 'p-c', 'p-d', 'p-e']);
  });

  it('prefers root diversity in the first pass when one conversation has multiple high-ranked replies', async () => {
    const rootA1 = cand('p-root-a-1', 'u1', 100, 1);
    rootA1.parentId = 'root-a';
    const rootA2 = cand('p-root-a-2', 'u2', 90, 1);
    rootA2.parentId = 'root-a';
    const rootB = cand('p-root-b', 'u3', 50, 1);
    rootB.parentId = 'root-b';
    const rootC = cand('p-root-c', 'u4', 40, 1);
    rootC.parentId = 'root-c';
    const { service } = setupForYou({
      candidates: [rootA1, rootA2, rootB, rootC],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 3, cursor: null, visibility: 'all' });
    expect(out.posts.map((p: any) => p.id)).toEqual(['p-root-a-1', 'p-root-b', 'p-root-c']);
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

  it('does not skip lower-ranked candidates from the first ranked universe across pages', async () => {
    const { service } = setupForYou({
      candidates: [
        cand('p1', 'u1', 100, 1),
        cand('p2', 'u2', 90, 1),
        cand('p3', 'u3', 80, 1),
      ],
    });

    const page1 = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 1,
      cursor: null,
      visibility: 'all',
    });
    const page2 = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 1,
      cursor: page1.nextCursor,
      visibility: 'all',
    });
    const page3 = await service.listForYouFeed({
      viewerUserId: 'viewer',
      limit: 1,
      cursor: page2.nextCursor,
      visibility: 'all',
    });

    expect(page1.posts.map((p: any) => p.id)).toEqual(['p1']);
    expect(page2.posts.map((p: any) => p.id)).toEqual(['p2']);
    expect(page3.posts.map((p: any) => p.id)).toEqual(['p3']);
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

  it('ranks engaged-with author (A+ tier) above plain mutual (A tier) at equal trendingScore and age', async () => {
    // Four posts, same trendingScore and age. Only the author's relationship to the viewer differs.
    // A+ (2.0×): viewer follows the author AND recently boosted their content.
    // A  (1.8×): mutual follow (no engagement history).
    // B  (1.1×): viewer follows, author does not follow back.
    // D  (0.15×): no relationship.
    const { service } = setupForYou({
      candidates: [
        cand('p-engaged',  'u-engaged',  10, 1),
        cand('p-mutual',   'u-mutual',   10, 1),
        cand('p-follow',   'u-follow',   10, 1),
        cand('p-stranger', 'u-stranger', 10, 1),
      ],
      youFollowAuthorIds:     ['u-engaged', 'u-mutual', 'u-follow'],
      followsYouAuthorIds:    ['u-mutual'],
      viewerBoostedAuthorIds: ['u-engaged'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    // A+ (engaged) must beat A (mutual) must beat B (follow) must beat D (stranger).
    expect(ids.indexOf('p-engaged')).toBeLessThan(ids.indexOf('p-mutual'));
    expect(ids.indexOf('p-mutual')).toBeLessThan(ids.indexOf('p-follow'));
    expect(ids.indexOf('p-follow')).toBeLessThan(ids.indexOf('p-stranger'));
  });

  it('ranks engaged-with author (A+ tier) via reply history above plain mutual', async () => {
    // Same as the boost variant but the engagement signal comes from the viewer's own replies.
    const { service } = setupForYou({
      candidates: [
        cand('p-replied-to', 'u-replied-to', 10, 1),
        cand('p-mutual',     'u-mutual',     10, 1),
      ],
      youFollowAuthorIds:       ['u-replied-to', 'u-mutual'],
      followsYouAuthorIds:      ['u-mutual'],
      viewerRepliedToAuthorIds: ['u-replied-to'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids.indexOf('p-replied-to')).toBeLessThan(ids.indexOf('p-mutual'));
  });

  it('demotes pure-discovery viral posts below friend-engaged posts with social proof', async () => {
    // A post engaged by one of the viewer's follows (friend-engaged) should outrank a viral
    // stranger post. Under the old base=trendingScore logic a trendingScore=20 stranger post
    // with relMult=0.15 after 40% demotion = 20*0.4*0.15=1.2 adjusted; the friend-engaged
    // post with base=6 (floor) and relMult=0.85 yields 6*0.85=5.1 — friend-engaged wins.
    const { service } = setupForYou({
      candidates: [
        cand('p-viral-stranger',  'u-stranger', 20, 1),
        cand('p-friend-boosted',  'u-quiet',    null, 1),
      ],
      youFollowAuthorIds: ['friend-1'],
      friendBoostPostIds: ['p-friend-boosted'],
    });

    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids.indexOf('p-friend-boosted')).toBeLessThan(ids.indexOf('p-viral-stranger'));
  });

  it('does not demote posts from authors in the social graph (followed/follower) even when seen', async () => {
    // A seen post from a followed author should keep its trendingScore base (not get 40% demotion)
    // because the author IS in the viewer's social graph. Only authors with no relationship at all
    // get the pure-discovery penalty.
    const { service } = setupForYou({
      candidates: [
        cand('p-seen-follow', 'u-follow', 10, 1),
        cand('p-stranger',    'u-stranger', 12, 1),
      ],
      youFollowAuthorIds: ['u-follow'],
      seenAtByPostId: { 'p-seen-follow': new Date() }, // recently seen → seenMult ≈ 0.12
    });

    // p-seen-follow: base=10 (NOT 10*0.4 since youFollowThem), relMult=1.1, seenMult≈0.12 → ~1.3
    // p-stranger:   base=12*0.4=4.8, relMult=0.15 → ~0.7
    // Even with the seen penalty, followed-author's post beats the demoted stranger.
    const out = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const ids = out.posts.map((p: any) => p.id);
    expect(ids.indexOf('p-seen-follow')).toBeLessThan(ids.indexOf('p-stranger'));
  });

  it('null viewerUserId: skips postView query, skips follow queries, returns discovery posts', async () => {
    // When viewerUserId is null the service must skip all personalized lookups
    // (no postView.findMany for last-seen, no follow.findMany for outbound follows)
    // and return public-only discovery posts from the trending/chrono lane.
    const candidates: ForYouCandidate[] = [
      { id: 'p-trend', userId: 'u-a', parentId: null, communityGroupId: null, trendingScore: 10, createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      { id: 'p-chrono', userId: 'u-b', parentId: null, communityGroupId: null, trendingScore: null, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    ];

    const postFindMany = jest.fn(async (args: any) => {
      if (args?.select) {
        let pool = candidates.slice();
        const ands: any[] = args?.where?.AND ?? [];
        const notIn = new Set<string>(ands.flatMap((c: any) => Array.isArray(c?.id?.notIn) ? c.id.notIn : []));
        if (notIn.size > 0) pool = pool.filter((c) => !notIn.has(c.id));
        const hasTrending = ands.some((c: any) => c?.trendingScore?.gt === 0);
        const hasChrono = ands.some(
          (c: any) => Array.isArray(c?.OR) && c.OR.some((o: any) => o?.trendingScore === 0) && c.OR.some((o: any) => o?.trendingScore === null),
        );
        if (hasTrending) pool = pool.filter((c) => c.trendingScore != null && c.trendingScore > 0);
        if (hasChrono) pool = pool.filter((c) => c.trendingScore == null || c.trendingScore === 0);
        return pool;
      }
      if (args?.include) {
        const ids: string[] = args.where?.id?.in ?? [];
        return ids.map((id) => {
          const c = candidates.find((x) => x.id === id);
          return { id, userId: c?.userId ?? 'u-unknown', createdAt: c?.createdAt ?? new Date(), trendingScore: c?.trendingScore ?? null, parentId: null, communityGroupId: null, kind: 'regular', visibility: 'public', deletedAt: null } as any;
        });
      }
      return [];
    });

    const postViewFindMany = jest.fn(async () => []);
    const followFindMany = jest.fn(async () => []);

    const { service } = makeService(
      {
        post: {
          findUnique: jest.fn(),
          findFirst: jest.fn(async () => null),
          groupBy: jest.fn(async () => []),
          findMany: postFindMany,
          update: jest.fn(async () => ({})),
          updateMany: jest.fn(async () => ({ count: 0 })),
          create: jest.fn(),
        },
        follow: { findMany: followFindMany },
        postView: { findMany: postViewFindMany },
        boost: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
        communityGroupMember: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
      },
      {
        viewerContext: {
          getViewer: jest.fn(async () => null),
          allowedPostVisibilities: jest.fn(() => ['public']),
          isPremium: jest.fn(() => false),
          isVerified: jest.fn(() => false),
        },
        redis: {
          getJson: jest.fn(async () => null),
          setJson: jest.fn(async () => undefined),
          del: jest.fn(async () => undefined),
        },
      },
    );

    const out = await service.listForYouFeed({ viewerUserId: null, limit: 10, cursor: null, visibility: 'all' });

    // Discovery posts returned.
    expect(out.posts.length).toBeGreaterThan(0);
    expect(out.posts.map((p: any) => p.id)).toContain('p-trend');

    // postView.findMany must NOT have been called — no last-seen for anonymous viewers.
    expect(postViewFindMany).not.toHaveBeenCalled();

    // follow.findMany for outbound-follows (followerId = viewerUserId) must NOT have been called.
    // More specifically: the viewer's own follow list fetch (where: { followerId: <viewerUserId> })
    // must not have happened, because viewerUserId is null.
    const allFollowArgs = followFindMany.mock.calls.map((callArgs: any[]) => callArgs[0]);
    expect(allFollowArgs.every((a: any) => a?.where?.followerId !== null)).toBe(true);
    // There should be no follow.findMany calls at all (no following IDs = no queries needed).
    expect(followFindMany).not.toHaveBeenCalled();
  });

  it('allocates a larger followed-unseen quota on page 1 than on deep pages', async () => {
    // Page 1 (no cursor): quota = ceil(limit * 0.70) — strongly user-first.
    // Page 3+ (cursor with >50 served IDs): quota = ceil(limit * 0.40) — more room for discovery.
    // Setup: 10 followed-unseen posts (low trending) + 5 high-trending stranger posts.
    // On page 1 the quota ensures 7 followed-unseen fill first, only 3 stranger slots remain.
    // On deep pages the quota is 4, so 5 strangers can fill in — more discovery.
    const followedCandidates = Array.from({ length: 10 }, (_, i) =>
      cand(`fu${i}`, `u-followed-${i}`, 2, 1),
    );
    const strangerCandidates = Array.from({ length: 5 }, (_, i) =>
      cand(`st${i}`, `u-stranger-${i}`, 1000, 1),
    );
    const youFollowAuthorIds = followedCandidates.map((c) => c.userId);
    const { service } = setupForYou({ candidates: [...followedCandidates, ...strangerCandidates], youFollowAuthorIds });

    // Page 1 — no cursor.
    const page1 = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: null, visibility: 'all' });
    const p1FollowedCount = page1.posts.filter((p: any) => youFollowAuthorIds.includes(p.userId)).length;
    const p1StrangerCount = page1.posts.filter((p: any) => !youFollowAuthorIds.includes(p.userId)).length;

    // Page 3+ — craft a cursor with 51 non-overlapping served IDs.
    const deepCursorData = { v: 2, s: Array.from({ length: 51 }, (_, i) => `old-${i}`) };
    const deepCursor = Buffer.from(JSON.stringify(deepCursorData), 'utf8').toString('base64url');
    const page3 = await service.listForYouFeed({ viewerUserId: 'viewer', limit: 10, cursor: deepCursor, visibility: 'all' });
    const p3FollowedCount = page3.posts.filter((p: any) => youFollowAuthorIds.includes(p.userId)).length;
    const p3StrangerCount = page3.posts.filter((p: any) => !youFollowAuthorIds.includes(p.userId)).length;

    // Page 1 must deliver more followed-unseen (and fewer strangers) than a deep page.
    expect(p1FollowedCount).toBeGreaterThan(p3FollowedCount);
    expect(p1StrangerCount).toBeLessThan(p3StrangerCount);
  });
});
