/**
 * Unit tests for NotificationPushService focusing on:
 *   1. Per-channel presence suppression (suppressActiveChannels)
 *   2. Per-subject coalescing keyed by resolved tag, not just kind
 */
import { NotificationPushService } from './notification-push.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { ApnsPushService } from './apns-push.service';
import type { NotificationKind } from '@prisma/client';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
}));

const webpush = jest.requireMock('web-push') as {
  setVapidDetails: jest.Mock;
  sendNotification: jest.Mock;
};

function makePrisma(opts?: {
  pushSubscriptions?: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
  coalesceRow?: { sentAt: Date } | null;
}) {
  return {
    pushSubscription: {
      count: jest.fn(async () => (opts?.pushSubscriptions ?? []).length),
      findMany: jest.fn(async () => opts?.pushSubscriptions ?? [
        { id: 'sub-1', endpoint: 'https://push.example.com/1', p256dh: 'p256dh-val', auth: 'auth-val' },
      ]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    pushCoalesce: {
      findUnique: jest.fn(async () => opts?.coalesceRow ?? null),
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    apnsDeviceToken: {
      findMany: jest.fn(async () => [{ id: 'tok-1', token: 'device-token', environment: 'production' }]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    notification: {
      count: jest.fn(async () => 2),
    },
    user: {
      findUnique: jest.fn(async () => ({ accountKind: 'person', username: 'alice' })),
    },
    userPageOperator: {
      findMany: jest.fn(async () => []),
    },
    post: {
      findUnique: jest.fn(async () => null),
    },
    communityGroup: {
      findUnique: jest.fn(async () => null),
    },
  } as any;
}

function makeAppConfig(opts?: { vapid?: boolean; apns?: boolean }) {
  return {
    vapidConfigured: jest.fn(() => opts?.vapid ?? true),
    apnsConfigured: jest.fn(() => opts?.apns ?? true),
    vapidPublicKey: jest.fn(() => 'fake-vapid-public-key'),
    vapidPrivateKey: jest.fn(() => 'fake-vapid-private-key'),
    pushFrontendBaseUrl: jest.fn(() => 'https://menofhunger.com'),
    allowedOrigins: jest.fn(() => ['https://menofhunger.com']),
    apns: jest.fn(() =>
      opts?.apns !== false
        ? { keyId: 'KEY1', teamId: 'TEAM1', privateKey: '---key---', bundleId: 'com.example.app' }
        : null,
    ),
    r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.example.com' })),
  } as any;
}

function makePreferences(opts?: { pushComment?: boolean }) {
  const prefs = { pushComment: opts?.pushComment ?? true, pushBoost: true, pushFollow: true, pushMention: true, pushMessage: true, pushRepost: true, pushNudge: true, pushFollowedPost: true, pushReplyNudge: true, pushCrewStreak: true, pushGroupActivity: true, pushDailyContent: true, pushCheckinReminder: true };
  const svc = {
    getPreferencesInternal: jest.fn(async () => prefs),
  } as unknown as NotificationPreferencesService;
  return svc;
}

function makeApns(opts?: { configured?: boolean }) {
  const apnsSendToUser = jest.fn(async () => {});
  const svc = {
    configured: jest.fn(() => opts?.configured ?? true),
    hasTokens: jest.fn(async () => true),
    sendToUser: apnsSendToUser,
  } as unknown as ApnsPushService;
  return { svc, apnsSendToUser };
}

/** Stub PresenceService with per-channel control. */
function makePresence(opts?: { iosActive?: boolean; webActive?: boolean; isOnline?: boolean; isIdle?: boolean }) {
  return {
    isUserOnline: jest.fn(() => opts?.isOnline ?? false),
    isUserIdle: jest.fn(() => opts?.isIdle ?? false),
    isUserActivelyOnChannel: jest.fn((userId: string, channel: 'web' | 'ios') => {
      if (channel === 'ios') return opts?.iosActive ?? false;
      return opts?.webActive ?? false;
    }),
    isUserViewingConversation: jest.fn(() => false),
  } as any;
}

function makeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    getOrSetJson: jest.fn(async ({ key, compute }: { key: string; compute: () => Promise<unknown> }) => {
      if (store.has(key)) return store.get(key);
      const v = await compute();
      store.set(key, v);
      return v;
    }),
    getOrSetNullableJson: jest.fn(async ({ key, compute }: { key: string; compute: () => Promise<unknown> }) => {
      if (store.has(key)) return store.get(key) ?? null;
      const v = await compute();
      store.set(key, v);
      return v ?? null;
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
    }),
  };
}

function makeService(opts?: {
  prisma?: any;
  vapid?: boolean;
  apnsConfigured?: boolean;
  preferences?: NotificationPreferencesService;
  apns?: { svc: ApnsPushService; apnsSendToUser: jest.Mock };
  presence?: any;
  cache?: ReturnType<typeof makeCache>;
}) {
  const prisma = opts?.prisma ?? makePrisma();
  const appConfig = makeAppConfig({ vapid: opts?.vapid ?? true, apns: opts?.apnsConfigured ?? true });
  const prefs = opts?.preferences ?? makePreferences();
  const { svc: apnsSvc, apnsSendToUser } = opts?.apns ?? makeApns();
  const presence = opts?.presence ?? makePresence();
  const cache = opts?.cache ?? makeCache();
  const svc = new NotificationPushService(prisma, appConfig, presence, prefs, apnsSvc, cache as any);
  return { svc, prisma, appConfig, prefs, apnsSvc, apnsSendToUser, presence, cache };
}

const notificationKinds = [
  'comment',
  'boost',
  'repost',
  'follow',
  'followed_post',
  'followed_article',
  'mention',
  'nudge',
  'poll_results_ready',
  'generic',
  'coin_transfer',
  'message',
  'group_join_request',
  'community_group_member_joined',
  'community_group_join_approved',
  'community_group_join_rejected',
  'community_group_member_removed',
  'community_group_disbanded',
  'crew_invite_received',
  'crew_invite_accepted',
  'crew_invite_declined',
  'crew_invite_cancelled',
  'crew_member_joined',
  'crew_member_left',
  'crew_member_kicked',
  'crew_owner_transferred',
  'crew_owner_transfer_vote',
  'crew_wall_mention',
  'crew_disbanded',
  'community_group_invite_received',
  'community_group_invite_accepted',
  'community_group_invite_declined',
  'community_group_invite_cancelled',
  'community_group_post',
  'marv_not_in_group',
  'status_update',
  'checkin_post',
  'word_of_the_day',
  'quote_of_the_day',
  'account_verified',
  'checkin_reminder',
  'on_this_day',
  'premium_started',
  'premium_ended',
  'space_reminder_day',
  'space_reminder_soon',
  'space_live',
  'space_schedule_cancelled',
  'space_schedule_rescheduled',
] as const satisfies readonly NotificationKind[];

describe('NotificationPushService — human-readable copy', () => {
  it.each(notificationKinds)('%s never exposes technical or generic fallback copy', (kind) => {
    const { svc } = makeService();
    const copy = svc.buildPushCopy({
      kind,
      actor: {
        id: 'actor-1',
        username: 'alice',
        name: 'Alice',
        avatarKey: null,
        avatarUpdatedAt: null,
      },
    });
    const visibleCopy = `${copy.title} ${copy.body ?? ''}`;

    expect(visibleCopy).not.toMatch(/\b[a-z]+(?:_[a-z]+)+\b/);
    expect(copy.title).not.toBe('New notification');
    expect(copy.body).not.toBe('You have a new notification.');
  });

  it.each([
    {
      kind: 'followed_post' as const,
      fallbackTitle: 'posted',
      body: 'Hitting the gym.',
      title: 'Alice posted',
    },
    {
      kind: 'checkin_post' as const,
      fallbackTitle: 'checked in',
      body: 'Day 12 — still hungry.',
      title: 'Alice checked in',
    },
    {
      kind: 'comment' as const,
      fallbackTitle: 'replied to your post',
      body: 'This is fire.',
      title: 'Alice replied to your post',
    },
    {
      kind: 'boost' as const,
      fallbackTitle: 'boosted your post',
      body: 'Original post preview',
      title: 'Alice boosted your post',
    },
    {
      kind: 'repost' as const,
      fallbackTitle: 'reposted your post',
      body: 'Original post preview',
      title: 'Alice reposted your post',
    },
    {
      kind: 'nudge' as const,
      fallbackTitle: 'nudged you',
      body: null,
      title: 'Alice nudged you',
    },
  ])('$kind title names the action; body can carry a preview', ({ kind, fallbackTitle, body, title }) => {
    const { svc } = makeService();
    const copy = svc.buildPushCopy({
      kind,
      actor: {
        id: 'actor-1',
        username: 'alice',
        name: 'Alice',
        avatarKey: null,
        avatarUpdatedAt: null,
      },
      fallbackTitle,
      body,
    });
    expect(copy.title).toBe(title);
    if (body) expect(copy.body).toBe(body);
  });
});

describe('NotificationPushService — per-channel suppression', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
  });

  it('labels the test notification as web push', async () => {
    const prisma = makePrisma({
      pushSubscriptions: [
        {
          id: 'sub-1',
          endpoint: 'https://push.example.com/1',
          p256dh: 'p256dh-val',
          auth: 'auth-val',
        },
      ],
    });
    const { svc } = makeService({ prisma });

    await expect(svc.sendTestPush('user-1')).resolves.toEqual({ sent: true });

    const payload = JSON.parse(webpush.sendNotification.mock.calls[0][1]) as {
      title: string;
      body: string;
    };
    expect(payload).toEqual(
      expect.objectContaining({
        title: 'Test web push',
        body: 'Web Push is working.',
      }),
    );
  });

  it('fans a page push to operator tokens with a titled prefix and recipientUserId', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ accountKind: 'page', username: 'menofhunger' });
    prisma.userPageOperator.findMany.mockResolvedValue([
      { operatorUserId: 'john' },
      { operatorUserId: 'steve' },
    ]);
    const { svc, apnsSendToUser } = makeService({ prisma });
    await svc.sendWebPushToRecipient('page-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(2);
    expect(apnsSendToUser).toHaveBeenCalledWith(
      'john',
      expect.objectContaining({
        title: '@menofhunger · New reply',
        recipientUserId: 'page-1',
        recipientUsername: 'menofhunger',
      }),
    );
    expect(apnsSendToUser).toHaveBeenCalledWith(
      'steve',
      expect.objectContaining({
        title: '@menofhunger · New reply',
        recipientUserId: 'page-1',
      }),
    );
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(webpush.sendNotification.mock.calls[0][1]) as {
      title: string;
      recipientUserId: string;
    };
    expect(payload.title).toBe('@menofhunger · New reply');
    expect(payload.recipientUserId).toBe('page-1');
  });

  it('sends to both channels when user is not active on either', async () => {
    const { svc, apnsSendToUser, prisma } = makeService({
      presence: makePresence({ iosActive: false, webActive: false }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveChannels: true,
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(prisma.pushCoalesce.upsert).toHaveBeenCalledTimes(1);
  });

  it('always sends APNs even when user is active on iOS — client decides whether to show banner', async () => {
    const { svc, apnsSendToUser } = makeService({
      presence: makePresence({ iosActive: true, webActive: false }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveWebChannel: true,
    });
    // iOS always receives the push; UNUserNotificationCenterDelegate handles display.
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    // Web is not active, so web push fires too.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('skips web but sends APNs when user is active on web only', async () => {
    const { svc, apnsSendToUser } = makeService({
      presence: makePresence({ iosActive: false, webActive: true }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveChannels: true,
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('sends APNs and skips web (no coalesce recorded) when active on both', async () => {
    const { svc, apnsSendToUser, prisma } = makeService({
      presence: makePresence({ iosActive: true, webActive: true }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveWebChannel: true,
    });
    // iOS always fires.
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    // Web is suppressed (user is online); coalesce is not recorded so the next offline event isn't blocked.
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(prisma.pushCoalesce.upsert).not.toHaveBeenCalled();
  });

  it('sends to both channels when suppressActiveChannels is NOT set, even if active on both', async () => {
    const { svc, apnsSendToUser } = makeService({
      presence: makePresence({ iosActive: true, webActive: true }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'Streak reminder',
      tag: 'streak-reminder-user-1',
      kind: 'streak_reminder',
      // suppressActiveChannels omitted — system push, should always fan out
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('treats idle user as inactive for channel suppression (idle = should still get push)', async () => {
    const presence = makePresence({ iosActive: false, webActive: false });
    // isUserActivelyOnChannel already returns false when idle (see PresenceService impl),
    // so here we just verify the call path: channel checks happen and both fire.
    const { svc, apnsSendToUser } = makeService({ presence });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New mention',
      tag: 'notif-mention-actor-a1',
      kind: 'mention',
      suppressActiveChannels: true,
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationPushService — per-subject coalescing', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
  });

  it('does NOT coalesce when tags differ (distinct subjects)', async () => {
    // coalesceRow = null → no prior coalesce, so both should go through
    const prisma = makePrisma({ coalesceRow: null });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendWebPushToRecipient('user-1', {
      title: 'Reply from Alice on post 1',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'Reply from Bob on post 2',
      tag: 'notif-comment-post-p2',
      kind: 'comment',
    });
    // Each tag gets its own coalesce lookup; with null result both fire
    expect(prisma.pushCoalesce.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_coalesceKey: { userId: 'user-1', coalesceKey: 'notif-comment-post-p1' } } }),
    );
    expect(prisma.pushCoalesce.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_coalesceKey: { userId: 'user-1', coalesceKey: 'notif-comment-post-p2' } } }),
    );
    expect(apnsSendToUser).toHaveBeenCalledTimes(2);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('coalesces when the same tag is within the window', async () => {
    // coalesceRow.sentAt = just now → within any window
    const prisma = makePrisma({ coalesceRow: { sentAt: new Date() } });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendWebPushToRecipient('user-1', {
      title: 'Reply from Alice on post 1',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
    });
    expect(apnsSendToUser).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('sends when same kind but different tag (old kind-only coalescing would have blocked)', async () => {
    // Simulate: first call was coalesced for the KIND, but a new subject has a fresh tag.
    // With the new per-tag system, findUnique is called with the tag key, not the kind.
    // Return null so the push fires.
    const prisma = makePrisma({ coalesceRow: null });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendWebPushToRecipient('user-1', {
      title: 'New boost on a different post',
      tag: 'notif-boost-post-p99',
      kind: 'boost',
    });
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(prisma.pushCoalesce.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_coalesceKey: { userId: 'user-1', coalesceKey: 'notif-boost-post-p99' } },
        create: expect.objectContaining({ coalesceKey: 'notif-boost-post-p99' }),
      }),
    );
  });

  it('test pushes skip coalesce check and do not record', async () => {
    const prisma = makePrisma({ coalesceRow: { sentAt: new Date() } });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendWebPushToRecipient('user-1', {
      title: 'Test notification',
      body: 'If you see this, push is working.',
      test: true,
    });
    expect(prisma.pushCoalesce.findUnique).not.toHaveBeenCalled();
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(prisma.pushCoalesce.upsert).not.toHaveBeenCalled();
  });
});

describe('NotificationPushService — sendKindPushForActor integration', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
  });

  it('sends push when preference is enabled and no active channel', async () => {
    const prisma = {
      ...makePrisma(),
      user: { findUnique: jest.fn(async () => ({ id: 'actor-1', username: 'alice', name: 'Alice', avatarKey: null, avatarUpdatedAt: null })) },
    };
    const { svc, apnsSendToUser } = makeService({
      prisma,
      presence: makePresence({ iosActive: false, webActive: false }),
    });
    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      body: 'Great post!',
      subjectPostId: 'post-1',
      notificationId: 'notif-1',
    });
    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('skips push when preference is disabled', async () => {
    const prisma = {
      ...makePrisma(),
      user: { findUnique: jest.fn(async () => null) },
    };
    const prefs = makePreferences({ pushComment: false });
    const { svc, apnsSendToUser } = makeService({ prisma, preferences: prefs });
    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(apnsSendToUser).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('always sends APNs even when user is active on iOS (web still fires since web not active)', async () => {
    const prisma = {
      ...makePrisma(),
      user: { findUnique: jest.fn(async () => ({ id: 'actor-1', username: 'bob', name: 'Bob', avatarKey: null, avatarUpdatedAt: null })) },
    };
    const { svc, apnsSendToUser } = makeService({
      prisma,
      presence: makePresence({ iosActive: true, webActive: false }),
    });
    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'follow',
      actorUserId: 'actor-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    // iOS always receives the push regardless of presence.
    expect(apnsSendToUser).toHaveBeenCalledTimes(1);
    // Web is not active so it also fires.
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('enriches reply APNs with actor, media, parent post, category, and root thread', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: 'avatars/alice.jpg',
      avatarUpdatedAt: null,
    });
    prisma.post.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'reply-1'
        ? {
            id: 'reply-1',
            deletedAt: null,
            rootId: 'root-1',
            media: [
              {
                kind: 'image',
                r2Key: 'posts/reply.jpg',
                thumbnailR2Key: null,
              },
            ],
          }
        : { id: 'parent-1', deletedAt: null, rootId: 'root-1' },
    );
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      actorPostId: 'reply-1',
      subjectPostId: 'parent-1',
      body: 'Great post!',
      notificationId: 'notif-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Alice replied to your post',
        subtitle: 'Replied to your post:',
        body: 'Replied to your post:\nGreat post!',
        category: 'moh.category.reply',
        threadId: 'post-root-1',
        actorUsername: 'alice',
        actorName: 'Alice',
        avatarUrl: 'https://cdn.example.com/avatars/alice.jpg',
        mediaUrl: 'https://cdn.example.com/posts/reply.jpg',
        postId: 'parent-1',
        mutableContent: true,
      }),
    );
  });

  it('sendMessagePush passes actorUsername, actorName, and avatarUrl to APNs', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'sender-1',
      username: 'brett',
      name: 'Brett Murphy',
      avatarKey: 'avatars/brett.jpg',
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendMessagePush({
      recipientUserId: 'user-1',
      senderUserId: 'sender-1',
      senderName: 'Brett Murphy',
      body: 'Hey man',
      conversationId: 'conv-1',
    });

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true,
        actorUsername: 'brett',
        actorName: 'Brett Murphy',
        avatarUrl: 'https://cdn.example.com/avatars/brett.jpg',
      }),
    );
  });

  it('sendMessagePush still sends when sender has no avatar', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'sender-1',
      username: 'brett',
      name: 'Brett Murphy',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendMessagePush({
      recipientUserId: 'user-1',
      senderUserId: 'sender-1',
      senderName: 'Brett Murphy',
      body: 'Hey man',
      conversationId: 'conv-1',
    });

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true, // actorUsername drives this
        actorUsername: 'brett',
        avatarUrl: null,
      }),
    );
  });

  it('does not expose a post reply action for article comments', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: 'avatars/alice.jpg',
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      subjectArticleId: 'article-1',
      notificationId: 'notif-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        category: null,
        postId: null,
      }),
    );
  });

  it('sets mutableContent true for actor with avatar', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'peter',
      name: 'Peter Finn',
      avatarKey: 'avatars/peter.jpg',
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'followed_post',
      actorUserId: 'actor-1',
      actorPostId: 'post-1',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true,
        avatarUrl: 'https://cdn.example.com/avatars/peter.jpg',
        actorUsername: 'peter',
        actorName: 'Peter Finn',
      }),
    );
  });

  it('sets mutableContent true for actor WITHOUT avatar so NSE can still donate a Communication Intent', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'anthony',
      name: 'Anthony Navarro',
      avatarKey: null,   // no profile photo
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'nudge',
      actorUserId: 'actor-1',
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true,   // must be true so NSE runs even without avatar
        avatarUrl: null,
        actorUsername: 'anthony',
      }),
    );
  });

  it('sets mutableContent false for system notifications with no actor', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null); // no actor
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'word_of_the_day',
      actorUserId: null,
      fallbackTitle: 'Good morning!',
      body: "Today's word is: Paleness — open for the definition.",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: false,
        title: 'Good morning!',
        body: "Today's word is: Paleness — open for the definition.",
        subtitle: null,
      }),
    );
  });

  it('does not echo system titles as subtitle (avoids Good morning / Good morning)', () => {
    const { svc } = makeService();
    const copy = svc.buildPushCopy({
      kind: 'word_of_the_day',
      actor: null,
      fallbackTitle: 'Good morning!',
      body: "Today's word is: Paleness — open for the definition.",
    });
    expect(copy.title).toBe('Good morning!');
    expect(copy.body).toBe("Today's word is: Paleness — open for the definition.");
    expect(copy.title).not.toBe(copy.body);
  });

  it('uses current group context for invite subtitle, avatar, thread, and action category', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    prisma.communityGroup.findUnique.mockResolvedValue({
      slug: 'builders',
      name: 'Builders',
      avatarImageUrl: 'https://cdn.example.com/groups/builders.jpg',
      deletedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'community_group_invite_received',
      actorUserId: 'actor-1',
      subjectGroupId: 'group-1',
      subjectCommunityGroupInviteId: 'invite-1',
      notificationId: 'notif-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Alice invited you to a group',
        subtitle: 'Builders',
        category: 'moh.category.groupInvite',
        threadId: 'group-group-1',
        avatarUrl: 'https://cdn.example.com/groups/builders.jpg',
        groupInviteId: 'invite-1',
        url: '/g/builders',
      }),
    );
  });

  it('routes join-request pushes to the pending-requests page', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'thomas',
      name: 'Thomas',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    prisma.communityGroup.findUnique.mockResolvedValue({
      slug: 'builders',
      name: 'Builders',
      avatarImageUrl: 'https://cdn.example.com/groups/builders.jpg',
      deletedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'group_join_request',
      actorUserId: 'actor-1',
      subjectGroupId: 'group-1',
      notificationId: 'notif-join',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        url: '/g/builders/pending',
      }),
    );
  });

  it.each([
    {
      kind: 'checkin_post' as const,
      fallbackTitle: 'checked in',
      body: 'Day 12 — still hungry.',
      subtitle: 'Checked in:',
      title: 'Alice checked in',
    },
    {
      kind: 'followed_post' as const,
      fallbackTitle: 'posted',
      body: 'Hitting the gym.',
      subtitle: 'Posted:',
      title: 'Alice posted',
    },
    {
      kind: 'boost' as const,
      fallbackTitle: 'boosted your post',
      body: 'Original post preview',
      subtitle: 'Boosted your post:',
      title: 'Alice boosted your post',
    },
    {
      kind: 'repost' as const,
      fallbackTitle: 'reposted your post',
      body: 'Original post preview',
      subtitle: 'Reposted your post:',
      title: 'Alice reposted your post',
    },
    {
      kind: 'nudge' as const,
      fallbackTitle: 'nudged you',
      body: null,
      subtitle: 'Nudged you:',
      title: 'Alice nudged you',
    },
    {
      kind: 'comment' as const,
      fallbackTitle: 'replied to your comment',
      body: 'Agree.',
      subtitle: 'Replied to your comment:',
      title: 'Alice replied to your comment',
    },
  ])(
    'puts $kind action in the subtitle and folds it into the APNs body for Communication UI',
    async ({ kind, fallbackTitle, body, subtitle, title }) => {
      const prisma = makePrisma();
      prisma.user.findUnique.mockResolvedValue({
        id: 'actor-1',
        username: 'alice',
        name: 'Alice',
        avatarKey: null,
        avatarUpdatedAt: null,
      });
      const { svc, apnsSendToUser } = makeService({ prisma });

      await svc.sendKindPushForActor({
        recipientUserId: 'user-1',
        kind,
        actorUserId: 'actor-1',
        fallbackTitle,
        body,
        notificationId: 'notif-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const expectedBody =
        body != null && String(body).trim()
          ? `${subtitle}\n${body}`
          : kind === 'nudge'
            ? 'Nudged you:\nOpen notifications to respond.'
            : subtitle;
      expect(apnsSendToUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ title, subtitle, body: expectedBody }),
      );
    },
  );

  it('folds the group name into invite action subtitles when both are present', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    prisma.communityGroup.findUnique.mockResolvedValue({
      slug: 'builders',
      name: 'Builders',
      avatarImageUrl: 'https://cdn.example.com/groups/builders.jpg',
      deletedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendKindPushForActor({
      recipientUserId: 'user-1',
      kind: 'community_group_invite_received',
      actorUserId: 'actor-1',
      subjectGroupId: 'group-1',
      subjectCommunityGroupInviteId: 'invite-1',
      fallbackTitle: 'invited you to their group',
      notificationId: 'notif-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        subtitle: 'Invited you to Builders:',
      }),
    );
  });
});

describe('NotificationPushService — sendReplyNudgePush', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
  });

  it('passes actorUsername, actorName, and avatarUrl to APNs', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: 'avatars/alice.jpg',
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendReplyNudgePush({
      recipientUserId: 'user-1',
      actorUserId: 'actor-1',
      notificationId: 'notif-1',
      actorPostId: 'post-1',
      bodySnippet: 'Great post!',
    });

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true,
        actorUsername: 'alice',
        actorName: 'Alice',
        avatarUrl: 'https://cdn.example.com/avatars/alice.jpg',
      }),
    );
  });

  it('still sends when actor has no avatar', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    const { svc, apnsSendToUser } = makeService({ prisma });

    await svc.sendReplyNudgePush({
      recipientUserId: 'user-1',
      actorUserId: 'actor-1',
      notificationId: 'notif-1',
      actorPostId: null,
    });

    expect(apnsSendToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        mutableContent: true,
        actorUsername: 'alice',
        avatarUrl: null,
      }),
    );
  });
});

describe('NotificationPushService — actor mini-profile cache', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
  });

  it('sendKindPushForActor reads actor from DB on first call and from cache on the second', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    const { svc } = makeService({ prisma });

    await svc.sendKindPushForActor({ recipientUserId: 'user-1', kind: 'follow', actorUserId: 'actor-1' });
    await svc.sendKindPushForActor({ recipientUserId: 'user-2', kind: 'follow', actorUserId: 'actor-1' });
    // Actor mini-profile is cached. Recipient lookups for token-owner fanout are separate.
    const actorReads = prisma.user.findUnique.mock.calls.filter(
      (c: [{ where?: { id?: string } }]) => c[0]?.where?.id === 'actor-1',
    );
    expect(actorReads).toHaveLength(1);
  });

  it('sendReplyNudgePush reads actor from DB on first call and from cache on the second', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'actor-1',
      username: 'alice',
      name: 'Alice',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    const { svc } = makeService({ prisma });

    await svc.sendReplyNudgePush({ recipientUserId: 'user-1', actorUserId: 'actor-1', notificationId: 'n1', actorPostId: null });
    await svc.sendReplyNudgePush({ recipientUserId: 'user-2', actorUserId: 'actor-1', notificationId: 'n2', actorPostId: null });
    const actorReads = prisma.user.findUnique.mock.calls.filter(
      (c: [{ where?: { id?: string } }]) => c[0]?.where?.id === 'actor-1',
    );
    expect(actorReads).toHaveLength(1);
  });

  it('sendMessagePush reads sender from DB on first call and from cache on the second', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: 'sender-1',
      username: 'bob',
      name: 'Bob',
      avatarKey: null,
      avatarUpdatedAt: null,
    });
    const { svc } = makeService({ prisma });

    await svc.sendMessagePush({ recipientUserId: 'user-1', senderUserId: 'sender-1', senderName: 'Bob', conversationId: 'conv-1' });
    await svc.sendMessagePush({ recipientUserId: 'user-2', senderUserId: 'sender-1', senderName: 'Bob', conversationId: 'conv-1' });
    const senderReads = prisma.user.findUnique.mock.calls.filter(
      (c: [{ where?: { id?: string } }]) => c[0]?.where?.id === 'sender-1',
    );
    expect(senderReads).toHaveLength(1);
  });
});
