import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPushService } from './notification-push.service';
import { ApnsPushService } from './apns-push.service';
import { NotificationReadStateService } from './notification-read-state.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationWriterService } from './notification-writer.service';
import { PostVisibilityReadService } from '../viewer/post-visibility-read.service';

type FacadeDeps = {
  prisma: any;
  appConfig: any;
  presenceRealtime: any;
  presenceRedis?: any;
  presence: any;
  jobs: any;
  posthog: any;
  viewerContextService: any;
};

const stubPresenceRedis = { isOnline: jest.fn(async () => false), isIdle: jest.fn(async () => false) };

function buildFacade(deps: FacadeDeps) {
  const preferences = new NotificationPreferencesService(deps.prisma);
  const apnsPush = new ApnsPushService(deps.prisma, deps.appConfig);
  const push = new NotificationPushService(deps.prisma, deps.appConfig, deps.presence, preferences, apnsPush);
  const readState = new NotificationReadStateService(deps.prisma, deps.presenceRealtime, deps.posthog);
  const postVisibility = new PostVisibilityReadService(deps.prisma, deps.appConfig, deps.viewerContextService);
  const query = new NotificationQueryService(deps.prisma, deps.appConfig, postVisibility, readState);
  const writer = new NotificationWriterService(deps.prisma, deps.presenceRealtime, deps.presenceRedis ?? stubPresenceRedis, deps.jobs, push, query, readState);
  const svc = new NotificationsService(preferences, push, apnsPush, readState, query, writer);
  return { svc, preferences, push, apnsPush, readState, query, writer };
}

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
  const presenceRedis = { isOnline: jest.fn(async () => false), isIdle: jest.fn(async () => false) } as any;
  const presence = { isUserViewingConversation: jest.fn(() => false) } as any;
  const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;
  const posthog = { capture: jest.fn() } as any;
  const viewerContextService = {
    getViewer: jest.fn(async () => null),
    allowedPostVisibilities: jest.fn(() => ['public', 'verifiedOnly', 'premiumOnly']),
  } as any;

  const { svc, query } = buildFacade({ prisma, appConfig, presenceRealtime, presenceRedis, presence, jobs, posthog, viewerContextService });
  return { svc, prisma, query };
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
    const { svc, prisma, query } = makeService({
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

    const buildSpy = jest.spyOn(query as any, 'buildNotificationDtoForRecipient');

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

  it('filters with notIn primary kinds when kind is "other"', async () => {
    const { svc, prisma } = makeService({
      prisma: {
        notification: {
          findUnique: jest.fn(),
          findMany: jest.fn(async () => [
            {
              id: 'n_coin',
              createdAt: new Date('2026-03-01T00:00:00.000Z'),
              kind: 'coin_transfer',
              deliveredAt: null,
              readAt: null,
              ignoredAt: null,
              nudgedBackAt: null,
              actorUserId: 'a1',
              actorPostId: null,
              subjectPostId: null,
              subjectUserId: null,
              title: null,
              body: null,
              actor: {
                id: 'a1',
                username: 'sender',
                name: 'Sender',
                avatarKey: null,
                avatarUpdatedAt: null,
                premium: false,
                isOrganization: false,
                verifiedStatus: 'none',
              },
            },
          ]),
          count: jest.fn(async () => 0),
          groupBy: jest.fn(async () => []),
        },
        post: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
        user: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
        follow: { findMany: jest.fn(async () => []) },
        userBlock: { findMany: jest.fn(async () => []) },
      } as any,
    });

    const res = await svc.list({ recipientUserId: 'u_recipient', limit: 30, cursor: null, kind: 'other' as any });

    // Verify findMany was called with notIn the primary kinds
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: expect.objectContaining({ notIn: expect.arrayContaining(['comment', 'mention', 'followed_post', 'follow', 'boost', 'message']) }),
        }),
      }),
    );

    // Results are returned ungrouped (each item is type 'single')
    expect(res.items.length).toBe(1);
    expect(res.items[0]?.type).toBe('single');
    if (res.items[0]?.type !== 'single') throw new Error('Expected single');
    expect(res.items[0].notification.kind).toBe('coin_transfer');
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
        kind: { notIn: ['message', 'community_group_post'] },
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
    const { svc } = buildFacade({
      prisma: prisma as any,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime: presenceRealtime as any,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn(async () => undefined) } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

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

    const presence = { isUserViewingConversation: jest.fn(() => false) } as any;
    const { svc } = buildFacade({ prisma, appConfig, presenceRealtime, presence, jobs, posthog, viewerContextService });
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
// markConversationMessageNotificationRead — DM read-on-open
// ---------------------------------------------------------------------------

describe('NotificationsService.markConversationMessageNotificationRead', () => {
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
    const { svc } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

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

// ─── Groups unread badge: markGroupPostsDelivered ─────────────────────────────

describe('NotificationReadStateService.markGroupPostsDelivered', () => {
  it('sets deliveredAt for community_group_post rows in the given group and emits groups:unreadChanged', async () => {
    const groupBy = jest.fn(async () => [{ subjectGroupId: 'g1', _count: { _all: 2 } }]);
    const updateMany = jest.fn(async () => ({ count: 2 }));
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitGroupsUnreadChanged: jest.fn(),
    } as any;
    const prisma = {
      notification: { updateMany, groupBy },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    } as any;
    const { readState } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

    await readState.markGroupPostsDelivered('u1', 'g1');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        recipientUserId: 'u1',
        kind: 'community_group_post',
        subjectGroupId: 'g1',
        deliveredAt: null,
      },
      data: { deliveredAt: expect.any(Date) },
    });
    // Verify groups:unreadChanged is eventually emitted (emitGroupsUnreadForUser is best-effort/async)
    // Wait a tick for the void promise to resolve
    await new Promise((r) => setImmediate(r));
    expect(presenceRealtime.emitGroupsUnreadChanged).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ total: expect.any(Number), byGroupId: expect.any(Object) }),
    );
  });

  it('does NOT set readAt (seen-only, not read)', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitGroupsUnreadChanged: jest.fn(),
    } as any;
    const prisma = {
      notification: { updateMany, groupBy: jest.fn(async () => []) },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    } as any;
    const { readState } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

    await readState.markGroupPostsDelivered('u1', 'g1');

    const calls = updateMany.mock.calls as any[][];
    const callArg = calls[0]?.[0];
    expect(callArg?.data?.readAt).toBeUndefined();
    expect(callArg?.data?.deliveredAt).toBeInstanceOf(Date);
  });
});

// ─── Groups unread badge: markReadBySubject does NOT read community_group_post on groupId ──

describe('NotificationReadStateService.markReadBySubject — community_group_post exclusion', () => {
  it('does NOT mark community_group_post as read when called with groupId only', async () => {
    const updateMany = jest.fn(async () => ({ count: 0 }));
    const executeRaw = jest.fn(async () => []);
    const count = jest.fn(async () => 0);
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationsWaitingChanged: jest.fn(),
      emitGroupsUnreadChanged: jest.fn(),
    } as any;
    const prisma = {
      notification: { updateMany, count },
      user: { findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 0 })) },
      $transaction: jest.fn(async (fn: any) => fn({
        notification: { updateMany, count },
        user: { update: jest.fn(async () => ({})) },
        $executeRaw: executeRaw,
      })),
      $executeRaw: executeRaw,
    } as any;
    const { readState } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

    await readState.markReadBySubject('u1', { groupId: 'g1' });

    // The OR clause for groupId must exclude community_group_post.
    const txCalls = updateMany.mock.calls as any[][];
    const txUpdateCall = txCalls[0]?.[0];
    const groupClause = txUpdateCall?.where?.OR?.find((c: any) => c.subjectGroupId === 'g1');
    expect(groupClause).toBeDefined();
    expect(groupClause?.kind?.not).toBe('community_group_post');
  });
});

// ─── NotificationWriterService.createGroupPostBadgeNotifications ─────────────

describe('NotificationWriterService.createGroupPostBadgeNotifications', () => {
  it('bulk-inserts badge rows for recipients (excluding actor) and emits groups:unreadChanged per recipient', async () => {
    const createMany = jest.fn(async () => ({ count: 2 }));
    const groupBy = jest.fn(async () => []);
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitGroupsUnreadChanged: jest.fn(),
    } as any;
    const prisma = {
      notification: { createMany, groupBy },
      user: { findUnique: jest.fn() },
    } as any;
    const { writer } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

    await writer.createGroupPostBadgeNotifications({
      actorUserId: 'author',
      postId: 'post-1',
      groupId: 'g1',
      recipientUserIds: ['m1', 'm2', 'author'],
    });

    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ recipientUserId: 'm1', kind: 'community_group_post', subjectGroupId: 'g1' }),
        expect.objectContaining({ recipientUserId: 'm2', kind: 'community_group_post', subjectGroupId: 'g1' }),
      ]),
      skipDuplicates: true,
    });
    // Actor should be excluded
    const createCalls = createMany.mock.calls as any[][];
    const insertedIds = (createCalls[0]?.[0] as any)?.data?.map((d: any) => d.recipientUserId) ?? [];
    expect(insertedIds).not.toContain('author');
    // Wait for emitGroupsUnreadForUser void promises
    await new Promise((r) => setImmediate(r));
    expect(presenceRealtime.emitGroupsUnreadChanged).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(presenceRealtime.emitGroupsUnreadChanged).toHaveBeenCalledWith('m2', expect.any(Object));
    expect(presenceRealtime.emitGroupsUnreadChanged).not.toHaveBeenCalledWith('author', expect.any(Object));
  });
});

// ─── deleteBySubjectPostId: group post badge rows don't drift the bell counter ──

describe('NotificationWriterService.deleteBySubjectPostId — community_group_post handling', () => {
  it('does NOT decrement the bell counter for community_group_post rows, and emits groups:unreadChanged', async () => {
    const deletedRows = [
      { id: 'n1', recipientUserId: 'm1', deliveredAt: null, kind: 'community_group_post' },
      { id: 'n2', recipientUserId: 'm2', deliveredAt: null, kind: 'boost' },
    ];
    const userUpdate = jest.fn(async () => ({ undeliveredNotificationCount: 0 }));
    const deleteMany = jest.fn(async () => ({ count: 2 }));
    const groupBy = jest.fn(async () => []);
    const presenceRealtime = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationsDeleted: jest.fn(),
      emitNotificationsWaitingChanged: jest.fn(),
      emitGroupsUnreadChanged: jest.fn(),
    } as any;
    const prisma = {
      notification: {
        findMany: jest.fn(async () => deletedRows),
        deleteMany,
        count: jest.fn(async () => 0),
        groupBy,
      },
      user: { update: userUpdate, findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn({
        notification: { deleteMany },
        user: { update: userUpdate },
      })),
    } as any;
    const { writer } = buildFacade({
      prisma,
      appConfig: { r2: jest.fn(() => null) } as any,
      presenceRealtime,
      presence: { isUserViewingConversation: jest.fn(() => false) } as any,
      jobs: { enqueueCron: jest.fn() } as any,
      posthog: { capture: jest.fn() } as any,
      viewerContextService: { getViewer: jest.fn(async () => null) } as any,
    });

    await writer.deleteBySubjectPostId('post-1');

    // The bell counter must only be decremented for the non-group-post row (m2), never m1.
    const decrementedUsers = userUpdate.mock.calls.map((c: any) => c[0]?.where?.id);
    expect(decrementedUsers).toContain('m2');
    expect(decrementedUsers).not.toContain('m1');

    // The group badge for m1 must be refreshed.
    await new Promise((r) => setImmediate(r));
    expect(presenceRealtime.emitGroupsUnreadChanged).toHaveBeenCalledWith('m1', expect.any(Object));
    expect(presenceRealtime.emitGroupsUnreadChanged).not.toHaveBeenCalledWith('m2', expect.any(Object));
  });
});

// ─── upsertMarvNotInGroupNotification — rate-limit ──────────────────────────

describe('NotificationWriterService.upsertMarvNotInGroupNotification', () => {
  function makeMarvService(opts: { recentExists: boolean }) {
    const notificationFindFirst = jest.fn(async () => opts.recentExists ? { id: 'existing' } : null);
    const notificationCreate = jest.fn(async () => ({ id: 'new-notif' }));
    const userUpdate = jest.fn(async () => ({ undeliveredNotificationCount: 1 }));
    const notificationCount = jest.fn(async () => 1);
    const presenceRealtime: any = {
      emitNotificationsUpdated: jest.fn(),
      emitNotificationNew: jest.fn(),
      emitWaitingChangedForUser: jest.fn(),
    };
    const prisma = {
      notification: { findFirst: notificationFindFirst, create: notificationCreate, count: notificationCount },
      user: { update: userUpdate },
      $transaction: jest.fn(async (cb: any) =>
        cb({
          notification: { create: notificationCreate, count: notificationCount },
          user: { update: userUpdate },
        })
      ),
    } as any;
    const appConfig: any = { r2: jest.fn(() => null) };
    const jobs: any = { enqueueCron: jest.fn() };
    const posthog: any = { capture: jest.fn() };
    const viewerContextService: any = {};
    const presence: any = {};
    const { svc, writer } = buildFacade({ prisma, appConfig, presenceRealtime, presence, jobs, posthog, viewerContextService });
    return { svc, writer, notificationFindFirst, notificationCreate, presenceRealtime };
  }

  it('skips notification when a recent one already exists (rate limit)', async () => {
    const { svc, notificationCreate } = makeMarvService({ recentExists: true });
    await svc.upsertMarvNotInGroupNotification({
      recipientUserId: 'user-1',
      marvUserId: 'marv-1',
      postId: 'post-1',
      groupId: 'group-1',
    });
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('creates notification when no recent one exists', async () => {
    const { svc, notificationCreate, presenceRealtime } = makeMarvService({ recentExists: false });
    await svc.upsertMarvNotInGroupNotification({
      recipientUserId: 'user-1',
      marvUserId: 'marv-1',
      postId: 'post-1',
      groupId: 'group-1',
    });
    expect(notificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'marv_not_in_group',
          actorUserId: 'marv-1',
          actorPostId: 'post-1',
          subjectGroupId: 'group-1',
        }),
      }),
    );
    expect(presenceRealtime.emitNotificationsUpdated).toHaveBeenCalled();
  });
});

