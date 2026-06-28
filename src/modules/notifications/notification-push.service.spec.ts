/**
 * Unit tests for NotificationPushService focusing on:
 *   1. Per-channel presence suppression (suppressActiveChannels)
 *   2. Per-subject coalescing keyed by resolved tag, not just kind
 */
import { NotificationPushService } from './notification-push.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { ApnsPushService } from './apns-push.service';

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
    r2: jest.fn(() => null),
  } as any;
}

function makePreferences(opts?: { pushComment?: boolean }) {
  const prefs = { pushComment: opts?.pushComment ?? true, pushBoost: true, pushFollow: true, pushMention: true, pushMessage: true, pushRepost: true, pushNudge: true, pushFollowedPost: true, pushReplyNudge: true, pushCrewStreak: true, pushGroupActivity: true };
  const svc = {
    getPreferencesInternal: jest.fn(async () => prefs),
  } as unknown as NotificationPreferencesService;
  return svc;
}

function makeApns(opts?: { configured?: boolean }) {
  const apnsSendToUser = jest.fn(async () => {});
  const svc = {
    configured: jest.fn(() => opts?.configured ?? true),
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

function makeService(opts?: {
  prisma?: any;
  vapid?: boolean;
  apnsConfigured?: boolean;
  preferences?: NotificationPreferencesService;
  apns?: { svc: ApnsPushService; apnsSendToUser: jest.Mock };
  presence?: any;
}) {
  const prisma = opts?.prisma ?? makePrisma();
  const appConfig = makeAppConfig({ vapid: opts?.vapid ?? true, apns: opts?.apnsConfigured ?? true });
  const prefs = opts?.preferences ?? makePreferences();
  const { svc: apnsSvc, apnsSendToUser } = opts?.apns ?? makeApns();
  const presence = opts?.presence ?? makePresence();
  const svc = new NotificationPushService(prisma, appConfig, presence, prefs, apnsSvc);
  return { svc, prisma, appConfig, prefs, apnsSvc, apnsSendToUser, presence };
}

describe('NotificationPushService — per-channel suppression', () => {
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.sendNotification.mockResolvedValue({});
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

  it('skips APNs but sends web when user is active on iOS only', async () => {
    const { svc, apnsSendToUser } = makeService({
      presence: makePresence({ iosActive: true, webActive: false }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveChannels: true,
    });
    expect(apnsSendToUser).not.toHaveBeenCalled();
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

  it('skips both channels and does NOT record coalesce when active on both', async () => {
    const { svc, apnsSendToUser, prisma } = makeService({
      presence: makePresence({ iosActive: true, webActive: true }),
    });
    await svc.sendWebPushToRecipient('user-1', {
      title: 'New reply',
      tag: 'notif-comment-post-p1',
      kind: 'comment',
      suppressActiveChannels: true,
    });
    expect(apnsSendToUser).not.toHaveBeenCalled();
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

  it('skips APNs only when user is active on iOS (web still fires)', async () => {
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
    expect(apnsSendToUser).not.toHaveBeenCalled();
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
