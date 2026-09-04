import { PostsSideEffectsHandler } from './posts-side-effects.handler';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

// ─── Deps factory ────────────────────────────────────────────────────────────
// These tests drive `runPostCreateSideEffects` directly with fully-formed args, which is how
// the notification-gating rules were originally covered. The rehydration step
// (ids → args) is covered separately below via `post.created`.

function makeHandler(overrides: { prisma?: Record<string, any> } = {}) {
  const prisma: any = {
    post: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    user: { findUnique: jest.fn(async () => null) },
    follow: { findMany: jest.fn(async () => []) },
    userPageOperator: { findMany: jest.fn(async () => []) },
    crewMember: { findMany: jest.fn(async () => []) },
    communityGroup: { findUnique: jest.fn(async () => null) },
    communityGroupMember: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    ...(overrides.prisma ?? {}),
  };
  const notifications: any = {
    create: jest.fn(async () => undefined),
    upsertRepostNotification: jest.fn(async () => undefined),
    createGroupPostBadgeNotifications: jest.fn(async () => undefined),
    upsertMarvNotInGroupNotification: jest.fn(async () => undefined),
    deleteBySubjectPostId: jest.fn(async () => undefined),
    deleteByActorPostId: jest.fn(async () => undefined),
  };
  const presenceRealtime: any = {
    emitFeedNewPost: jest.fn(),
    emitGroupNewPost: jest.fn(),
    emitCheckinAnsweredToday: jest.fn(),
    emitUsersMeUpdated: jest.fn(),
    emitPostsTyping: jest.fn(),
  };
  const appConfig: any = {
    r2: jest.fn(() => null),
    marvBot: jest.fn(() => ({ enabled: false, username: 'marv', userId: null })),
  };
  const jobs: any = { enqueue: jest.fn(async () => undefined) };
  const marvIdentity: any = {
    cachedMarvUserId: jest.fn(() => null),
    getMarvUserId: jest.fn(async () => null),
  };
  const linkMetadata: any = {
    extractLinks: jest.fn(() => []),
    backfillForUrls: jest.fn(async () => 0),
  };
  const registry = new SideEffectsRegistry();
  const sideEffects: any = { dispatch: jest.fn() };

  const handler = new PostsSideEffectsHandler(
    prisma,
    notifications,
    presenceRealtime,
    appConfig,
    jobs,
    marvIdentity,
    linkMetadata,
    registry,
    sideEffects,
    { enqueueIfNeeded: jest.fn(async () => undefined) } as any,
  );

  const deps = {
    prisma,
    notifications,
    presenceRealtime,
    appConfig,
    jobs,
    marvIdentity,
    linkMetadata,
    registry,
    sideEffects,
  };
  return { handler, deps };
}

function runSideEffects(handler: PostsSideEffectsHandler, args: Record<string, unknown>): Promise<void> {
  return (handler as any).runPostCreateSideEffects({
    actorUserId: 'author',
    parentId: null,
    parentAuthorUserId: null,
    threadPostsForRoles: [],
    bodyMentionIds: [],
    bodyMentionSet: new Set<string>(),
    bodySnippet: '',
    visibility: 'public',
    quotedInfo: null,
    didAwardStreak: false,
    requestedMarvMode: null,
    ...args,
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

describe('PostsSideEffectsHandler registration', () => {
  it('registers every post effect so the processor can resolve them by job name', () => {
    const { handler, deps } = makeHandler();

    handler.onModuleInit();

    expect(deps.registry.names()).toEqual(['post.created', 'post.deleted', 'post.engagement.changed', 'post.quote.changed']);
  });
});

// ─── post.deleted ────────────────────────────────────────────────────────────

describe('PostsSideEffectsHandler post.deleted', () => {
  it('removes notifications that referenced the post as subject and as actor post', async () => {
    const { handler, deps } = makeHandler();

    await (handler as any).onPostDeleted({ postId: 'p1' });

    expect(deps.notifications.deleteBySubjectPostId).toHaveBeenCalledWith('p1');
    expect(deps.notifications.deleteByActorPostId).toHaveBeenCalledWith('p1');
  });

  it('ignores a blank post id', async () => {
    const { handler, deps } = makeHandler();

    await (handler as any).onPostDeleted({ postId: '  ' });

    expect(deps.notifications.deleteBySubjectPostId).not.toHaveBeenCalled();
  });
});

// ─── post.engagement.changed ─────────────────────────────────────────────────

describe('PostsSideEffectsHandler post.engagement.changed', () => {
  const base = { postId: 'p1', recipientUserId: 'author', actorUserId: 'booster' };

  function withBody(body: string, kind = 'regular') {
    const ctx = makeHandler();
    ctx.deps.prisma.post.findFirst = jest.fn(async () => ({ body, kind }));
    ctx.deps.notifications.upsertBoostNotification = jest.fn(async () => undefined);
    ctx.deps.notifications.deleteBoostNotification = jest.fn(async () => undefined);
    ctx.deps.notifications.deleteRepostNotification = jest.fn(async () => undefined);
    return ctx;
  }

  it('re-reads the post body so a retry carries current text', async () => {
    const { handler, deps } = withBody('  edited body  ');

    await (handler as any).onEngagementChanged({ ...base, kind: 'boost', active: true });

    expect(deps.notifications.upsertBoostNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectPostId: 'p1',
        bodySnippet: 'edited body',
        subjectPostKind: 'regular',
      }),
    );
  });

  it('titles status boosts as status', async () => {
    const { handler, deps } = withBody('feeling strong', 'status');

    await (handler as any).onEngagementChanged({ ...base, kind: 'boost', active: true });

    expect(deps.notifications.upsertBoostNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectPostId: 'p1',
        bodySnippet: 'feeling strong',
        subjectPostKind: 'status',
      }),
    );
  });

  it('writes nothing when the post was deleted before the job ran', async () => {
    const { handler, deps } = withBody('x');
    deps.prisma.post.findFirst = jest.fn(async () => null);

    await (handler as any).onEngagementChanged({ ...base, kind: 'boost', active: true });

    expect(deps.notifications.upsertBoostNotification).not.toHaveBeenCalled();
  });

  it('deletes the notification when the engagement was removed', async () => {
    const { handler, deps } = withBody('x');

    await (handler as any).onEngagementChanged({ ...base, kind: 'boost', active: false });

    expect(deps.notifications.deleteBoostNotification).toHaveBeenCalledWith('author', 'booster', 'p1');
    expect(deps.notifications.upsertBoostNotification).not.toHaveBeenCalled();
  });

  it('points a repost notification at the repost row so the author can tap through', async () => {
    const { handler, deps } = withBody('x');

    await (handler as any).onEngagementChanged({
      ...base,
      kind: 'repost',
      active: true,
      actorPostId: 'repost-1',
    });

    expect(deps.notifications.upsertRepostNotification).toHaveBeenCalledWith({
      recipientUserId: 'author',
      actorUserId: 'booster',
      subjectPostId: 'p1',
      actorPostId: 'repost-1',
    });
  });

  it('removes the repost notification on unrepost', async () => {
    const { handler, deps } = withBody('x');

    await (handler as any).onEngagementChanged({ ...base, kind: 'repost', active: false });

    expect(deps.notifications.deleteRepostNotification).toHaveBeenCalledWith('author', 'booster', 'p1');
  });

  // One failed delete must not prevent the other — cleanup is best-effort.
  it('still attempts the actor-post cleanup when the subject cleanup rejects', async () => {
    const { handler, deps } = makeHandler();
    deps.notifications.deleteBySubjectPostId.mockRejectedValue(new Error('db down'));

    await expect((handler as any).onPostDeleted({ postId: 'p1' })).resolves.toBeUndefined();

    expect(deps.notifications.deleteByActorPostId).toHaveBeenCalledWith('p1');
  });
});

// ─── post.created rehydration ────────────────────────────────────────────────
//
// Payloads carry ids only, so the handler must re-read the post. Two behaviors matter:
// a post deleted before the job runs is a no-op, and body mentions are re-parsed from the
// persisted body rather than trusted from a snapshot.

describe('PostsSideEffectsHandler post.created rehydration', () => {
  it('does nothing when the post was deleted before the job ran', async () => {
    const { handler, deps } = makeHandler();
    deps.prisma.post.findFirst.mockResolvedValue(null);

    await (handler as any).onPostCreated({
      postId: 'p1',
      actorUserId: 'author',
      didAwardStreak: false,
      requestedMarvMode: null,
    });

    expect(deps.notifications.create).not.toHaveBeenCalled();
  });

  it('ignores a payload missing ids', async () => {
    const { handler, deps } = makeHandler();

    await (handler as any).onPostCreated({ postId: '', actorUserId: '', didAwardStreak: false, requestedMarvMode: null });

    expect(deps.prisma.post.findFirst).not.toHaveBeenCalled();
  });

  it('re-parses body mentions from the persisted post rather than a request-time snapshot', async () => {
    const { handler, deps } = makeHandler();
    deps.prisma.post.findFirst.mockResolvedValue({
      id: 'p1',
      userId: 'author',
      body: 'hey @alice',
      kind: 'regular',
      visibility: 'public',
      parentId: null,
      rootId: null,
      quotedPostId: null,
      communityGroupId: null,
      checkinDayKey: null,
      user: { name: 'Author', username: 'author' },
      mentions: [],
      media: [],
      poll: null,
    });
    deps.prisma.user.findMany = jest.fn(async () => [{ id: 'alice-id', username: 'alice' }]);

    await (handler as any).onPostCreated({
      postId: 'p1',
      actorUserId: 'author',
      didAwardStreak: false,
      requestedMarvMode: null,
    });

    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['alice-id']);
  });
});

// ─── Mention notifications gated by group privacy ────────────────────────────
//
// The mention loop must:
//   • notify all explicitly @mentioned users for non-group posts
//   • notify all mentioned users for posts in OPEN community groups
//   • notify only ACTIVE members for posts in PRIVATE (approval) community groups —
//     mentioning someone who can't read the post is a dead end and leaks the existence
//     of private content.

describe('PostsSideEffectsHandler — mention privacy gating', () => {
  function setup() {
    return makeHandler();
  }

  function basePost(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'post-1',
      userId: 'author',
      communityGroupId: null,
      user: { name: 'Test Author', username: 'testauthor' },
      ...overrides,
    } as any;
  }

  async function callSideEffects(handler: PostsSideEffectsHandler, args: any): Promise<void> {
    await runSideEffects(handler, {
      post: basePost(args.postOverrides),
      bodyMentionIds: args.bodyMentionIds ?? [],
      bodyMentionSet: new Set(args.bodyMentionIds ?? []),
    });
  }

  it('notifies every mentioned user when the post is not in a community group', async () => {
    const { handler, deps } = setup();
    await callSideEffects(handler, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: null },
    });
    expect(deps.prisma.communityGroup.findUnique).not.toHaveBeenCalled();
    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('notifies every mentioned user when the post is in an OPEN community group', async () => {
    const { handler, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(handler, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: 'g1' },
    });

    expect(deps.prisma.communityGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1' } }),
    );
    // For open groups, findMany must NOT be called for mention-gating (userId.in check).
    // The badge fan-out may call findMany with a different shape (userId.not).
    const mentionGatingCalls = deps.prisma.communityGroupMember.findMany.mock.calls.filter((c: any[]) =>
      Array.isArray(c[0]?.where?.userId?.in),
    );
    expect(mentionGatingCalls).toHaveLength(0);
    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('only notifies active members when the post is in a PRIVATE (approval) community group', async () => {
    const { handler, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'approval' });
    deps.prisma.communityGroupMember.findMany.mockResolvedValue([{ userId: 'u1' }]);

    await callSideEffects(handler, {
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
    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['u1']);
  });

  it('suppresses all mentions for a private group when the membership lookup fails (fail closed)', async () => {
    const { handler, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'approval' });
    deps.prisma.communityGroupMember.findMany.mockRejectedValue(new Error('db down'));

    await callSideEffects(handler, {
      bodyMentionIds: ['u1', 'u2'],
      postOverrides: { communityGroupId: 'g1' },
    });

    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls).toHaveLength(0);
  });

  it('does not call findUnique for join-policy when there are no mentions (only calls it for group name)', async () => {
    const { handler, deps } = setup();
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ name: 'Test Group' });
    await callSideEffects(handler, {
      bodyMentionIds: [],
      postOverrides: { communityGroupId: 'g1' },
    });
    // findUnique IS called — for the group name used in badge notification titles.
    expect(deps.prisma.communityGroup.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: { name: true }, where: { id: 'g1' } }),
    );
  });
});

// ─── Followed-post bell semantics ────────────────────────────────────────────

describe('PostsSideEffectsHandler — followed-post bell semantics', () => {
  function setup() {
    const { handler, deps } = makeHandler();
    deps.prisma.follow.findMany = jest.fn(async () => [
      {
        followerId: 'normal-follower',
        postNotificationsEnabled: false,
        follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false },
      },
      {
        followerId: 'bell-follower',
        postNotificationsEnabled: true,
        follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false },
      },
    ]);
    return { handler, deps };
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
      communityGroupId: null,
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
        verifiedStatus: 'identity',
        avatarKey: null,
        avatarUpdatedAt: null,
        orgMemberships: [],
        bannedAt: null,
      },
      ...overrides,
    } as any;
  }

  async function callSideEffects(handler: PostsSideEffectsHandler, args: any): Promise<void> {
    await runSideEffects(handler, {
      post: basePost(args.postOverrides),
      parentId: args.parentId ?? null,
      parentAuthorUserId: args.parentAuthorUserId ?? null,
      threadPostsForRoles: args.threadPostsForRoles ?? [],
      bodyMentionIds: args.bodyMentionIds ?? [],
      bodyMentionSet: new Set(args.bodyMentionSet ?? args.bodyMentionIds ?? []),
      visibility: args.visibility ?? 'public',
      quotedInfo: args.quotedInfo ?? null,
    });
  }

  it('notifies all eligible followers for top-level posts', async () => {
    const { handler, deps } = setup();

    await callSideEffects(handler, {});

    const followedPostCalls = deps.notifications.create.mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'followed_post',
    );
    expect(followedPostCalls.map((c: any[]) => c[0].recipientUserId).sort()).toEqual([
      'bell-follower',
      'normal-follower',
    ]);
    expect(deps.presenceRealtime.emitFeedNewPost).toHaveBeenCalledWith(
      ['normal-follower', 'bell-follower'],
      expect.any(Object),
    );
  });

  it('does not notify page operators who follow the page, but still emits to their feed', async () => {
    const { handler, deps } = setup();
    deps.prisma.userPageOperator.findMany = jest.fn(async () => [
      { operatorUserId: 'bell-follower' },
    ]);

    await callSideEffects(handler, {});

    const followedPostCalls = deps.notifications.create.mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'followed_post',
    );
    expect(followedPostCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['normal-follower']);
    expect(deps.presenceRealtime.emitFeedNewPost).toHaveBeenCalledWith(
      ['normal-follower', 'bell-follower'],
      expect.any(Object),
    );
  });

  it('only notifies bell-enabled followers for replies they are not already involved in', async () => {
    const { handler, deps } = setup();

    await callSideEffects(handler, {
      parentId: 'parent-1',
      parentAuthorUserId: 'parent-author',
    });

    const followedPostCalls = deps.notifications.create.mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'followed_post',
    );
    expect(followedPostCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['bell-follower']);
    expect(deps.presenceRealtime.emitFeedNewPost).not.toHaveBeenCalled();
  });

  it('splits a large follower set into chunk jobs instead of writing them inline', async () => {
    const { handler, deps } = setup();
    const followers = Array.from({ length: 450 }, (_, i) => `f${i}`);
    deps.prisma.follow.findMany = jest.fn(async () =>
      followers.map((followerId) => ({
        followerId,
        postNotificationsEnabled: true,
        follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false },
      })),
    );

    await callSideEffects(handler, {});

    const followedPostCalls = deps.notifications.create.mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'followed_post',
    );
    expect(followedPostCalls).toHaveLength(0);

    const chunkJobs = deps.sideEffects.dispatch.mock.calls.filter(
      (c: any[]) => c[0] === 'notification.fanout.chunk',
    );
    expect(chunkJobs).toHaveLength(3);
    expect(chunkJobs.flatMap((c: any[]) => c[1].recipientUserIds)).toEqual(followers);
    expect(chunkJobs[0][1]).toMatchObject({ kind: 'followed_post', subjectPostId: 'post-1' });
  });
});

// ─── Group post notification membership gating ───────────────────────────────

describe('PostsSideEffectsHandler — group notification gating', () => {
  function setup(activeMemberIds: string[] = []) {
    const { handler, deps } = makeHandler();
    deps.prisma.communityGroupMember.findMany = jest.fn(async (args: any) => {
      const ids: string[] = args?.where?.userId?.in ?? [];
      return activeMemberIds.filter((id) => ids.includes(id)).map((userId) => ({ userId }));
    });
    return { handler, deps };
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
        verifiedStatus: 'identity',
        avatarKey: null,
        avatarUpdatedAt: null,
        orgMemberships: [],
        bannedAt: null,
      },
      ...overrides,
    } as any;
  }

  async function callSideEffects(handler: PostsSideEffectsHandler, args: any): Promise<void> {
    await runSideEffects(handler, {
      post: basePost(args.postOverrides),
      parentId: args.parentId ?? null,
      parentAuthorUserId: args.parentAuthorUserId ?? null,
      threadPostsForRoles: args.threadPostsForRoles ?? [],
      bodyMentionIds: args.bodyMentionIds ?? [],
      bodyMentionSet: new Set(args.bodyMentionSet ?? args.bodyMentionIds ?? []),
      visibility: args.visibility ?? 'public',
      quotedInfo: args.quotedInfo ?? null,
    });
  }

  it('skips followed_post notifications and emitFeedNewPost for top-level group posts', async () => {
    const { handler, deps } = setup(['member-follower']);
    deps.prisma.follow.findMany = jest.fn(async () => [
      { followerId: 'member-follower', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
      { followerId: 'outside-follower', follower: { verifiedStatus: 'identity', premium: false, premiumPlus: false } },
    ]);

    await callSideEffects(handler, {
      postOverrides: { communityGroupId: 'g1' },
    });

    const followedPostCalls = deps.notifications.create.mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'followed_post',
    );
    // Group posts no longer send followed_post notifications or home-feed pushes.
    expect(followedPostCalls).toHaveLength(0);
    expect(deps.presenceRealtime.emitFeedNewPost).not.toHaveBeenCalled();
  });

  it('suppresses reply notifications for non-members of the post group', async () => {
    const { handler, deps } = setup(['parent-member', 'thread-member']);

    await callSideEffects(handler, {
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

    const commentCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'comment');
    expect(commentCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['parent-member', 'thread-member']);
  });

  it('suppresses quote notifications for non-members of the post group', async () => {
    const { handler, deps } = setup([]);

    await callSideEffects(handler, {
      quotedInfo: { quotedAuthorId: 'quoted-author', quotedPostId: 'quoted-post' },
      postOverrides: { communityGroupId: 'g1' },
    });

    expect(deps.notifications.upsertRepostNotification).not.toHaveBeenCalled();
  });

  it('allows non-member mentions only for public posts in open groups', async () => {
    const { handler, deps } = setup([]);
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(handler, {
      bodyMentionIds: ['outside-mentioned'],
      visibility: 'public',
      postOverrides: { communityGroupId: 'g1', visibility: 'public' },
    });

    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls.map((c: any[]) => c[0].recipientUserId)).toEqual(['outside-mentioned']);
    // For open groups, findMany must NOT be called for mention-gating (userId.in check).
    // The badge fan-out may call findMany with a different shape (userId.not).
    const mentionGatingCalls = deps.prisma.communityGroupMember.findMany.mock.calls.filter((c: any[]) =>
      Array.isArray(c[0]?.where?.userId?.in),
    );
    expect(mentionGatingCalls).toHaveLength(0);
  });

  it('suppresses non-member mentions in open groups when the post is not public', async () => {
    const { handler, deps } = setup([]);
    deps.prisma.communityGroup.findUnique.mockResolvedValue({ joinPolicy: 'open' });

    await callSideEffects(handler, {
      bodyMentionIds: ['outside-mentioned'],
      visibility: 'verifiedOnly',
      postOverrides: { communityGroupId: 'g1', visibility: 'verifiedOnly' },
    });

    const mentionCalls = deps.notifications.create.mock.calls.filter((c: any[]) => c[0]?.kind === 'mention');
    expect(mentionCalls).toHaveLength(0);
  });
});

// ─── Tier-scoped group emit ──────────────────────────────────────────────────
//
// Public group posts emit synchronously from createPost. Only non-public ones land here,
// because building their audience requires a full member+tier scan.

describe('PostsSideEffectsHandler — tier-scoped groups:newPost', () => {
  function makePost(overrides: Record<string, unknown> = {}) {
    return {
      id: 'post-1',
      userId: 'author',
      body: 'hello',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      parentId: null,
      communityGroupId: 'g1',
      visibility: 'premiumOnly',
      kind: 'regular',
      media: [],
      mentions: [],
      poll: null,
      topics: [],
      hashtags: [],
      user: { id: 'author', username: 'author', name: 'Author', orgMemberships: [] },
      ...overrides,
    } as any;
  }

  it('emits only to members who meet the premium requirement', async () => {
    const { handler, deps } = makeHandler();
    deps.prisma.communityGroupMember.findMany.mockResolvedValue([
      { userId: 'premium-member', user: { premium: true, premiumPlus: false, verifiedStatus: 'none' } },
      { userId: 'free-member', user: { premium: false, premiumPlus: false, verifiedStatus: 'identity' } },
    ]);

    await (handler as any).emitTierScopedGroupNewPost(makePost());

    expect(deps.presenceRealtime.emitGroupNewPost).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ groupId: 'g1' }),
      { eligibleMemberUserIds: ['premium-member'] },
    );
  });

  it('does not run for public group posts (createPost already emitted those)', async () => {
    const { handler, deps } = makeHandler();

    await (handler as any).emitTierScopedGroupNewPost(makePost({ visibility: 'public' }));

    expect(deps.prisma.communityGroupMember.findMany).not.toHaveBeenCalled();
    expect(deps.presenceRealtime.emitGroupNewPost).not.toHaveBeenCalled();
  });

  it('does not run for replies', async () => {
    const { handler, deps } = makeHandler();

    await (handler as any).emitTierScopedGroupNewPost(makePost({ parentId: 'parent-1' }));

    expect(deps.presenceRealtime.emitGroupNewPost).not.toHaveBeenCalled();
  });

  it('skips the emit when no member is eligible', async () => {
    const { handler, deps } = makeHandler();
    deps.prisma.communityGroupMember.findMany.mockResolvedValue([
      { userId: 'free-member', user: { premium: false, premiumPlus: false, verifiedStatus: 'none' } },
    ]);

    await (handler as any).emitTierScopedGroupNewPost(makePost());

    expect(deps.presenceRealtime.emitGroupNewPost).not.toHaveBeenCalled();
  });
});

// ─── Marv enqueue: explicit @marv only ───────────────────────────────────────

describe('PostsSideEffectsHandler maybeEnqueueMarvReply', () => {
  function marvPost(overrides: Record<string, unknown> = {}) {
    return {
      id: 'p-reply',
      userId: 'alice',
      body: 'thanks',
      parentId: 'p-marv',
      rootId: 'p-root',
      communityGroupId: null,
      visibility: 'public',
      user: { name: 'Alice', username: 'alice' },
      mentions: [],
      media: [],
      poll: null,
      ...overrides,
    };
  }

  it('enqueues when the body explicitly mentions @marv', async () => {
    const { handler, deps } = makeHandler();
    deps.appConfig.marvBot.mockReturnValue({ enabled: true, username: 'marv', userId: 'marv-id' });
    deps.marvIdentity.cachedMarvUserId.mockReturnValue('marv-id');

    await (handler as any).maybeEnqueueMarvReply({
      post: marvPost({ body: 'hey @marv what do you think?' }),
      actorUserId: 'alice',
      bodySnippet: 'hey @marv',
      visibility: 'public',
      requestedMarvMode: null,
    });

    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ postId: 'p-reply', requestingUserId: 'alice' }),
      expect.any(Object),
    );
    expect(deps.presenceRealtime.emitPostsTyping).toHaveBeenCalledWith(
      'p-reply',
      expect.objectContaining({
        postId: 'p-reply',
        typing: true,
        status: 'replying',
        user: expect.objectContaining({ id: 'marv-id', username: 'marv' }),
      }),
    );
  });

  it('enqueues a direct reply to a Marv post without an explicit @marv', async () => {
    const { handler, deps } = makeHandler();
    deps.appConfig.marvBot.mockReturnValue({ enabled: true, username: 'marv', userId: 'marv-id' });
    deps.marvIdentity.cachedMarvUserId.mockReturnValue('marv-id');

    await (handler as any).maybeEnqueueMarvReply({
      post: marvPost({ body: 'yeah I agree' }),
      actorUserId: 'alice',
      bodySnippet: 'yeah I agree',
      visibility: 'public',
      requestedMarvMode: null,
      parentAuthorUserId: 'marv-id',
    });

    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ postId: 'p-reply', requestingUserId: 'alice' }),
      expect.any(Object),
    );
  });

  it('does not enqueue a reply to someone else just because Marv is in the thread', async () => {
    const { handler, deps } = makeHandler();
    deps.appConfig.marvBot.mockReturnValue({ enabled: true, username: 'marv', userId: 'marv-id' });
    deps.marvIdentity.cachedMarvUserId.mockReturnValue('marv-id');

    await (handler as any).maybeEnqueueMarvReply({
      post: marvPost({ body: 'yeah I agree', parentId: 'p-alice' }),
      actorUserId: 'bob',
      bodySnippet: 'yeah I agree',
      visibility: 'public',
      requestedMarvMode: null,
      parentAuthorUserId: 'alice',
    });

    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});
