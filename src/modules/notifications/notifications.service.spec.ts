import { NotificationsService } from './notifications.service';

function makeService(overrides?: { prisma?: any }) {
  const basePrisma = {
    notification: { findUnique: jest.fn(), findMany: jest.fn(async () => []), count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
    post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
    user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 0 })) },
    follow: { findMany: jest.fn(async () => []) },
    userBlock: { findMany: jest.fn(async () => []) },
    boost: { findMany: jest.fn(async () => []) },
    bookmark: { findMany: jest.fn(async () => []) },
    postPollVote: { findMany: jest.fn(async () => []) },
    communityGroup: { findMany: jest.fn(async () => []) },
    communityGroupMember: { findMany: jest.fn(async () => []) },
  } as any;
  const prisma = overrides?.prisma
    ? {
        ...basePrisma,
        ...overrides.prisma,
        notification: { ...basePrisma.notification, ...(overrides.prisma.notification ?? {}) },
        post: { ...basePrisma.post, ...(overrides.prisma.post ?? {}) },
        user: { ...basePrisma.user, ...(overrides.prisma.user ?? {}) },
        follow: { ...basePrisma.follow, ...(overrides.prisma.follow ?? {}) },
        userBlock: { ...basePrisma.userBlock, ...(overrides.prisma.userBlock ?? {}) },
        boost: { ...basePrisma.boost, ...(overrides.prisma.boost ?? {}) },
        bookmark: { ...basePrisma.bookmark, ...(overrides.prisma.bookmark ?? {}) },
        postPollVote: { ...basePrisma.postPollVote, ...(overrides.prisma.postPollVote ?? {}) },
        communityGroup: { ...basePrisma.communityGroup, ...(overrides.prisma.communityGroup ?? {}) },
        communityGroupMember: { ...basePrisma.communityGroupMember, ...(overrides.prisma.communityGroupMember ?? {}) },
      }
    : basePrisma;

  const appConfig = { r2: jest.fn(() => null) } as any;
  const presenceRealtime = {
    emitNotificationsDeleted: jest.fn(),
    emitNotificationsUpdated: jest.fn(),
    emitNotificationNew: jest.fn(),
  } as any;
  const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;
  const posthog = { capture: jest.fn() } as any;
  const viewerContextService = {
    getViewer: jest.fn(async () => null),
    allowedPostVisibilities: jest.fn(() => ['public', 'verifiedOnly', 'premiumOnly']),
  } as any;

  const svc = new NotificationsService(prisma, appConfig, presenceRealtime, jobs, posthog, viewerContextService);
  return { svc, prisma };
}

function makePost(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    editedAt: null,
    editCount: 0,
    body: 'Post body',
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
    repostedPostId: null,
    media: [],
    mentions: [],
    poll: null,
    userId: 'actor',
    user: {
      id: 'actor',
      username: 'actor',
      name: 'Actor',
      premium: false,
      premiumPlus: false,
      isOrganization: false,
      stewardBadgeEnabled: true,
      verifiedStatus: 'none',
      avatarKey: null,
      avatarUpdatedAt: null,
      bannedAt: null,
      orgAffiliations: [],
    },
    ...overrides,
  };
}

describe('NotificationsService.list batching', () => {
  it('batch loads subject posts/users (no per-notification findUnique/DTO builder)', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(async () => ({ id: 'cursor', createdAt: new Date('2026-01-01T00:00:00.000Z') })),
          findMany: jest.fn(async () => [
            {
              id: 'n1',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              kind: 'comment',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: 'p_actor_1',
              subjectPostId: 'p1',
              subjectUserId: null,
              title: null,
              body: 'hi',
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
            {
              id: 'n2',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              kind: 'follow',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a2',
              actorPostId: null,
              subjectPostId: null,
              subjectUserId: 'u_subject_1',
              title: null,
              body: null,
              actor: {
                id: 'a2',
                username: 'actor2',
                name: 'Actor2',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: true,
                isOrganization: false,
                verifiedStatus: 'identity',
              },
            },
          ]),
          count: jest.fn(async () => 2),
          groupBy: jest.fn(async () => []),
        },
        post: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            {
              id: 'p1',
              body: 'hello world',
              visibility: 'public',
              media: [],
            },
          ]),
        },
        user: {
          // called by getUndeliveredCountInternal
          findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 2 })),
          findMany: jest.fn(async () => [{ id: 'u_subject_1', premium: false, verifiedStatus: 'manual' }]),
        },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    const buildSpy = jest.spyOn(svc as any, 'buildNotificationDtoForRecipient');

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.undeliveredCount).toBe(2);
    const followItem = res.items.find((item) => item.type === 'single' && item.notification.kind === 'follow');
    if (followItem?.type !== 'single') throw new Error('Expected follow notification item');
    expect(followItem.notification.post).toBeNull();

    // Batch post/user loads (not per notification).
    expect(prisma.post.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);

    // No per-notification loads.
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
    // notification.findUnique is allowed only for cursor lookup; cursor is null in this test.
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();

    // Ensure list() doesn't fall back to per-notification builder.
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('uses the actor post as the repost notification preview target', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            {
              id: 'n_repost',
              createdAt: new Date('2026-02-02T00:00:00.000Z'),
              kind: 'repost',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: 'p_quote',
              subjectPostId: 'p_original',
              subjectUserId: null,
              title: 'quoted your post',
              body: null,
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
          ]),
          count: jest.fn(async () => 1),
          groupBy: jest.fn(async () => []),
        },
        post: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            makePost('p_quote', { body: 'This is why the original post matters.' }),
          ]),
        },
        user: {
          findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 1 })),
          findMany: jest.fn(async () => []),
        },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null });
    const item = res.items[0];

    expect(prisma.post.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['p_quote', 'p_original'] } },
    }));
    expect(item?.type).toBe('single');
    if (item?.type !== 'single') throw new Error('Expected single notification item');
    expect(item.notification.actorPostId).toBe('p_quote');
    expect(item.notification.subjectPostId).toBe('p_original');
    expect(item.notification.subjectPostPreview?.bodySnippet).toBe('This is why the original post matters.');
    expect(item.notification.post?.id).toBe('p_quote');
  });

  it('attaches full post payloads for followed posts, replies, and post mentions', async () => {
    const { svc } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            {
              id: 'n_followed',
              createdAt: new Date('2026-02-03T00:00:00.000Z'),
              kind: 'followed_post',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: null,
              subjectPostId: 'p_followed',
              subjectUserId: null,
              title: null,
              body: null,
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
            {
              id: 'n_reply',
              createdAt: new Date('2026-02-02T00:00:00.000Z'),
              kind: 'comment',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: 'p_reply',
              subjectPostId: 'p_root',
              subjectUserId: null,
              title: null,
              body: 'reply',
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
            {
              id: 'n_mention',
              createdAt: new Date('2026-02-01T00:00:00.000Z'),
              kind: 'mention',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: 'p_mention',
              subjectPostId: 'p_mention',
              subjectUserId: 'u_recipient',
              title: null,
              body: 'mentioned you',
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
          ]),
          count: jest.fn(async () => 3),
          groupBy: jest.fn(async () => []),
        },
        post: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            makePost('p_followed', { body: 'New post from someone you follow.' }),
            makePost('p_reply', { body: 'Actual reply row.' }),
            makePost('p_mention', { body: '@u_recipient hey.' }),
            makePost('p_root', { body: 'Original post.' }),
          ]),
        },
        user: {
          findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 3 })),
          findMany: jest.fn(async () => []),
        },
      } as any,
    });

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null });

    expect(res.items).toHaveLength(3);
    expect(res.items[0]?.type).toBe('single');
    expect(res.items[1]?.type).toBe('single');
    expect(res.items[2]?.type).toBe('single');
    if (res.items[0]?.type !== 'single' || res.items[1]?.type !== 'single' || res.items[2]?.type !== 'single') {
      throw new Error('Expected single notification items');
    }
    expect(res.items[0].notification.post?.id).toBe('p_followed');
    expect(res.items[1].notification.post?.id).toBe('p_reply');
    expect(res.items[2].notification.post?.id).toBe('p_mention');
  });

  it('falls back to the original post preview for plain repost notifications', async () => {
    const { svc } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            {
              id: 'n_repost',
              createdAt: new Date('2026-02-02T00:00:00.000Z'),
              kind: 'repost',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: 'p_repost',
              subjectPostId: 'p_original',
              subjectUserId: null,
              title: 'reposted your post',
              body: null,
              actor: {
                id: 'a1',
                username: 'actor',
                name: 'Actor',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
          ]),
          count: jest.fn(async () => 1),
          groupBy: jest.fn(async () => []),
        },
        post: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            makePost('p_repost', { body: '', kind: 'repost', repostedPostId: 'p_original' }),
            makePost('p_original', { body: 'Original post preview.' }),
          ]),
        },
        user: {
          findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 1 })),
          findMany: jest.fn(async () => []),
        },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null });
    const item = res.items[0];

    expect(item?.type).toBe('single');
    if (item?.type !== 'single') throw new Error('Expected single notification item');
    expect(item.notification.actorPostId).toBe('p_repost');
    expect(item.notification.subjectPostPreview?.bodySnippet).toBe('Original post preview.');
  });

  it('does not expose chat message notifications in the notifications feed', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => []),
          count: jest.fn(async () => 0),
          groupBy: jest.fn(async () => []),
        },
        post: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
        user: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null, kind: 'message' as any });

    expect(res).toEqual({ items: [], nextCursor: null, undeliveredCount: 0, unreadByKind: { all: 0 } });
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.getUndeliveredCount', () => {
  it('excludes chat message notifications from the bell badge count', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => []),
          count: jest.fn(async () => 4),
        },
        post: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
        user: { findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 99 })), findMany: jest.fn(async () => []) },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    await expect(svc.getUndeliveredCount('u_recipient')).resolves.toBe(4);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: {
        recipientUserId: 'u_recipient',
        deliveredAt: null,
        kind: { not: 'message' },
      },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('NotificationsService.markNewPostsRead', () => {
  it('marks followed_post notifications read and delivered, then emits the remaining badge count', async () => {
    const notification = {
      updateMany: jest.fn()
        .mockResolvedValueOnce({ count: 3 })
        .mockResolvedValueOnce({ count: 5 }),
      count: jest.fn(async () => 7),
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
    };
    const tx = {
      notification,
      $executeRaw: jest.fn(async () => undefined),
    };
    const prisma = {
      notification,
      post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
      user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
      follow: { findMany: jest.fn(async () => []) },
      userBlock: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (txArg: any) => Promise<any>) => fn(tx)),
    };
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationsDeleted: jest.fn(),
      emitNotificationNew: jest.fn(),
    };
    const svc = new NotificationsService(
      prisma as any,
      { r2: jest.fn(() => null) } as any,
      presenceRealtime as any,
      { enqueueCron: jest.fn(async () => undefined) } as any,
      { capture: jest.fn() } as any,
      { getViewer: jest.fn(async () => null) } as any,
    );

    await expect(svc.markNewPostsRead('viewer-1')).resolves.toEqual({ undeliveredCount: 7 });

    expect(notification.updateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        recipientUserId: 'viewer-1',
        kind: 'followed_post',
        deliveredAt: null,
      }),
      data: { deliveredAt: expect.any(Date) },
    });
    expect(notification.updateMany).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({
        recipientUserId: 'viewer-1',
        kind: 'followed_post',
      }),
      data: { readAt: expect.any(Date), deliveredAt: expect.any(Date) },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(notification.count).toHaveBeenCalledWith({ where: { recipientUserId: 'viewer-1', deliveredAt: null } });
    expect(presenceRealtime.emitNotificationsUpdated).toHaveBeenCalledWith('viewer-1', { undeliveredCount: 7 });
  });
});

// ---------------------------------------------------------------------------
// upsertGroupMemberJoinedNotification — create-then-update semantics
// ---------------------------------------------------------------------------

describe('NotificationsService.upsertGroupMemberJoinedNotification', () => {
  function makeUpsertService(existingNotification: null | { id: string; deliveredAt: Date | null }) {
    const created = { id: 'new-notif' };
    const notification = {
      findFirst: jest.fn(async () => existingNotification),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => created),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
    };
    const user = {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    };
    const prisma = {
      notification,
      user,
      post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
      follow: { findMany: jest.fn(async () => []) },
      userBlock: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) =>
        fn({ notification, user }),
      ),
      notificationPreferences: {
        upsert: jest.fn(async () => ({
          pushComment: true, pushBoost: true, pushFollow: true, pushMention: true,
          pushMessage: true, pushRepost: true, pushNudge: true, pushFollowedPost: true,
          pushReplyNudge: true, pushCrewStreak: true, pushGroupActivity: false,
        })),
      },
    } as any;

    const appConfig = { r2: jest.fn(() => null) } as any;
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationNew: jest.fn(),
      emitNotificationsDeleted: jest.fn(),
    } as any;
    const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;
    const posthog = { capture: jest.fn() } as any;
    const viewerContextService = { getViewer: jest.fn(async () => null) } as any;

    const svc = new NotificationsService(prisma, appConfig, presenceRealtime, jobs, posthog, viewerContextService);
    return { svc, prisma, presenceRealtime };
  }

  it('creates a new row when none exists', async () => {
    const { svc, prisma, presenceRealtime } = makeUpsertService(null);

    await svc.upsertGroupMemberJoinedNotification({
      recipientUserId: 'r1',
      joinerUserId: 'j1',
      groupId: 'g1',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'community_group_member_joined', subjectGroupId: 'g1' }),
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { undeliveredNotificationCount: { increment: 1 } } }),
    );
    expect(presenceRealtime.emitNotificationsUpdated).toHaveBeenCalledWith('r1', expect.any(Object));
  });

  it('bumps an existing undelivered row (does not increment counter)', async () => {
    const { svc, prisma } = makeUpsertService({ id: 'existing', deliveredAt: null });

    await svc.upsertGroupMemberJoinedNotification({
      recipientUserId: 'r1',
      joinerUserId: 'j1',
      groupId: 'g1',
    });

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing' },
        data: expect.objectContaining({ createdAt: expect.any(Date), deliveredAt: null, readAt: null }),
      }),
    );
    // wasDelivered = false → no counter increment
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('re-marks as unread and increments counter when previously delivered', async () => {
    const { svc, prisma } = makeUpsertService({ id: 'existing', deliveredAt: new Date() });

    await svc.upsertGroupMemberJoinedNotification({
      recipientUserId: 'r1',
      joinerUserId: 'j1',
      groupId: 'g1',
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { undeliveredNotificationCount: { increment: 1 } } }),
    );
  });

  it('skips self-notification (joiner === recipient)', async () => {
    const { svc, prisma } = makeUpsertService(null);

    await svc.upsertGroupMemberJoinedNotification({
      recipientUserId: 'same',
      joinerUserId: 'same',
      groupId: 'g1',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertMessageNotification — DM dedupe and read-on-open
// ---------------------------------------------------------------------------

describe('NotificationsService.upsertMessageNotification', () => {
  function makeMessageService(existingNotification: null | { id: string; deliveredAt: Date | null }) {
    const notification = {
      findFirst: jest.fn(async () => existingNotification),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ id: 'new-msg-notif' })),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
    };
    const user = {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    };
    const prisma = {
      notification,
      user,
      post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
      follow: { findMany: jest.fn(async () => []) },
      userBlock: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) =>
        fn({ notification, user }),
      ),
      notificationPreferences: { upsert: jest.fn(async () => ({ pushGroupActivity: false, pushMessage: true })) },
    } as any;
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationNew: jest.fn(),
      emitNotificationsDeleted: jest.fn(),
    } as any;
    const svc = new NotificationsService(
      prisma,
      { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      { enqueueCron: jest.fn() } as any,
      { capture: jest.fn() } as any,
      { getViewer: jest.fn(async () => null) } as any,
    );
    return { svc, prisma, presenceRealtime };
  }

  it('creates a new message notification row', async () => {
    const { svc, prisma } = makeMessageService(null);

    await svc.upsertMessageNotification({ recipientUserId: 'r1', senderUserId: 's1', conversationId: 'c1' });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'message', subjectConversationId: 'c1' }),
      }),
    );
  });

  it('re-bumps existing row when another message arrives in the same conversation', async () => {
    const { svc, prisma } = makeMessageService({ id: 'existing-msg', deliveredAt: null });

    await svc.upsertMessageNotification({ recipientUserId: 'r1', senderUserId: 's1', conversationId: 'c1' });

    expect(prisma.notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-msg' },
        data: expect.objectContaining({ deliveredAt: null, readAt: null }),
      }),
    );
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('marks notification read + decrements counter when conversation is opened', async () => {
    const notif = { id: 'msg-notif', deliveredAt: null, readAt: null };
    const notification = {
      findFirst: jest.fn(async () => notif),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(async () => []),
    };
    const user = { update: jest.fn(async () => ({})), findUnique: jest.fn(), findMany: jest.fn(async () => []) };
    const prisma = {
      notification,
      user,
      post: { findMany: jest.fn(async () => []) },
      follow: { findMany: jest.fn(async () => []) },
      userBlock: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) => fn({ notification, user })),
    } as any;
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationsDeleted: jest.fn(),
      emitNotificationNew: jest.fn(),
    } as any;
    const svc = new NotificationsService(
      prisma,
      { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      { enqueueCron: jest.fn() } as any,
      { capture: jest.fn() } as any,
      { getViewer: jest.fn(async () => null) } as any,
    );

    await svc.markConversationMessageNotificationRead({ userId: 'r1', conversationId: 'c1' });

    expect(notification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'msg-notif' },
        data: expect.objectContaining({ readAt: expect.any(Date) }),
      }),
    );
    // undelivered → decrement
    expect(user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { undeliveredNotificationCount: { decrement: 1 } } }),
    );
    expect(presenceRealtime.emitNotificationsDeleted).toHaveBeenCalledWith('r1', { notificationIds: ['msg-notif'] });
  });
});

