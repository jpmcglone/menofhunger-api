import { BookmarksService } from './bookmarks.service';

// Locks in the realtime fan-out contract for bookmarks: every change to the
// bookmark count must reach BOTH the actor/author (via posts:interaction, used
// to flip viewerHasBookmarked) AND the post room (via posts:liveUpdated, used
// by every passive viewer to update their displayed count). Without the room
// fan-out, viewers other than the author saw stale counts.

function makeService(overrides: Partial<Record<string, any>> = {}) {
  const prisma: any = {
    post: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    bookmark: {
      createMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => ({ id: 'bm-1' })),
    },
    bookmarkCollection: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    bookmarkCollectionItem: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
    },
    communityGroupMember: { findUnique: jest.fn(async () => ({ status: 'active' })) },
    $transaction: jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        const tx: any = {
          bookmark: {
            createMany: jest.fn(async () => ({ count: 1 })),
            deleteMany: jest.fn(async () => ({ count: 1 })),
            findUnique: jest.fn(async () => ({ id: 'bm-1' })),
          },
          bookmarkCollectionItem: {
            deleteMany: jest.fn(async () => ({ count: 0 })),
            createMany: jest.fn(async () => ({ count: 0 })),
          },
          post: { update: jest.fn(async () => ({})) },
        };
        return fn(tx);
      }
      return Promise.all(fn);
    }),
  };

  const presenceRealtime: any = {
    emitPostsInteraction: jest.fn(),
    emitPostsLiveUpdated: jest.fn(),
  };
  const viewerContext: any = {
    getViewer: jest.fn(async () => ({ id: 'u1', verifiedStatus: 'verified', premium: false })),
    allowedPostVisibilities: jest.fn(() => ['public', 'followers']),
  };
  const postViews: any = { markViewed: jest.fn(async () => undefined) };
  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const redis: any = {
    del: jest.fn(async () => undefined),
    getJson: jest.fn(async () => null),
    setJson: jest.fn(async () => undefined),
  };

  const deps = { prisma, presenceRealtime, viewerContext, postViews, jobs, redis, ...overrides };
  const service = new BookmarksService(
    deps.prisma,
    deps.presenceRealtime,
    deps.viewerContext,
    deps.postViews,
    deps.jobs,
    deps.redis,
  );
  return { service, deps };
}

describe('BookmarksService.setBookmark — realtime fan-out', () => {
  it('emits posts:liveUpdated to the post room with the new bookmarkCount on add', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findFirst.mockResolvedValueOnce({
      id: 'p1',
      userId: 'author',
      visibility: 'public',
      communityGroupId: null,
    });
    // After the in-tx increment, the post-room fan-out reads the new count.
    deps.prisma.post.findUnique.mockResolvedValueOnce({ bookmarkCount: 5 });

    await service.setBookmark({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledTimes(1);
    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        postId: 'p1',
        reason: 'bookmark_changed',
        patch: { bookmarkCount: 5 },
        version: expect.any(String),
      }),
    );
  });

  it('still emits the targeted posts:interaction so the actor flips viewerHasBookmarked', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findFirst.mockResolvedValueOnce({
      id: 'p1',
      userId: 'author',
      visibility: 'public',
      communityGroupId: null,
    });
    deps.prisma.post.findUnique.mockResolvedValueOnce({ bookmarkCount: 5 });

    await service.setBookmark({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsInteraction).toHaveBeenCalledTimes(1);
    const [recipients, payload] = deps.presenceRealtime.emitPostsInteraction.mock.calls[0];
    expect(recipients).toBeInstanceOf(Set);
    expect(Array.from(recipients as Set<string>).sort()).toEqual(['author', 'u1']);
    expect(payload).toEqual(
      expect.objectContaining({
        postId: 'p1',
        actorUserId: 'u1',
        kind: 'bookmark',
        active: true,
        bookmarkCount: 5,
      }),
    );
  });

  it('skips the room fan-out when the post-row count is missing (defensive)', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findFirst.mockResolvedValueOnce({
      id: 'p1',
      userId: 'author',
      visibility: 'public',
      communityGroupId: null,
    });
    // Simulate a row that disappeared between tx and the followup read.
    deps.prisma.post.findUnique.mockResolvedValueOnce(null);

    await service.setBookmark({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
    // posts:interaction still fires (the actor must always flip their UI).
    expect(deps.presenceRealtime.emitPostsInteraction).toHaveBeenCalled();
  });
});

describe('BookmarksService.removeBookmark — realtime fan-out', () => {
  it('emits posts:liveUpdated to the post room with the new bookmarkCount on remove', async () => {
    const { service, deps } = makeService();
    // Initial findUnique resolves the post author.
    deps.prisma.post.findUnique.mockResolvedValueOnce({ userId: 'author' });
    // The followup read after the decrement returns the current count.
    deps.prisma.post.findUnique.mockResolvedValueOnce({ bookmarkCount: 4 });

    await service.removeBookmark({ userId: 'u1', postId: 'p1' });

    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledTimes(1);
    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        postId: 'p1',
        reason: 'bookmark_changed',
        patch: { bookmarkCount: 4 },
      }),
    );
  });

  it('emits to the actor (and skips the missing author) when the post is gone', async () => {
    const { service, deps } = makeService();
    deps.prisma.post.findUnique.mockResolvedValueOnce(null);
    deps.prisma.post.findUnique.mockResolvedValueOnce({ bookmarkCount: 0 });

    await service.removeBookmark({ userId: 'u1', postId: 'p1' });

    const [recipients] = deps.presenceRealtime.emitPostsInteraction.mock.calls[0];
    expect(Array.from(recipients as Set<string>)).toEqual(['u1']);
    // Room fan-out still happens — passive viewers may have the post in their feed cache.
    expect(deps.presenceRealtime.emitPostsLiveUpdated).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ patch: { bookmarkCount: 0 } }),
    );
  });
});
