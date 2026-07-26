/**
 * Unit tests for status_update notification fan-out:
 *   1. fan-out hits every follower
 *   2. no self-notify (actor is never a recipient)
 *   3. push is sent on first create
 *   4. push is NOT sent when inside the 6h cooldown
 *   5. push IS sent again after the cooldown window
 */

import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPushService } from './notification-push.service';
import { ApnsPushService } from './apns-push.service';
import { NotificationReadStateService } from './notification-read-state.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationWriterService } from './notification-writer.service';
import { PostVisibilityReadService } from '../viewer/post-visibility-read.service';

const stubPresenceRedis = { isOnline: jest.fn(async () => false), isIdle: jest.fn(async () => false) };
const stubPresenceRealtime = {
  emitNotificationsUpdated: jest.fn(),
  emitNotificationNew: jest.fn(),
  emitNotificationsDeleted: jest.fn(),
};
const stubJobs = { enqueueCron: jest.fn(async () => undefined) };
const stubPosthog = { capture: jest.fn() };
const stubViewerContext = { getViewer: jest.fn(async () => null), allowedPostVisibilities: jest.fn(() => ['public']) };
const stubAppConfig = { r2: jest.fn(() => null) } as any;
const stubPresence = { isUserViewingConversation: jest.fn(() => false) };

function makeDefaultPrefs() {
  return {
    pushComment: true, pushBoost: true, pushFollow: true, pushMention: true,
    pushMessage: true, pushRepost: true, pushNudge: true, pushFollowedPost: true,
    pushReplyNudge: true, pushCrewStreak: true, pushGroupActivity: true,
  };
}

function buildServices(prismaOverrides: Record<string, any>) {
  const prisma = {
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (args: any) => ({ id: 'notif-created', ...args.data })),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 1),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    user: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({ username: 'actor-user' })),
      findMany: jest.fn(async () => []),
    },
    follow: { findMany: jest.fn(async () => []) },
    userBlock: { findMany: jest.fn(async () => []) },
    post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
    pushSubscription: { findMany: jest.fn(async () => []) },
    pushCoalesce: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({})),
    },
    apnsDeviceToken: { findMany: jest.fn(async () => []) },
    notificationPreferences: {
      upsert: jest.fn(async () => makeDefaultPrefs()),
    },
    $transaction: jest.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({
        notification: prisma.notification,
        user: prisma.user,
      }),
    ),
    ...prismaOverrides,
  } as any;

  const preferences = new NotificationPreferencesService(prisma);
  const apnsPush = new ApnsPushService(prisma, stubAppConfig);
  const push = new NotificationPushService(prisma, stubAppConfig, stubPresence as any, preferences, apnsPush);
  const readState = new NotificationReadStateService(prisma, stubPresenceRealtime as any, stubPosthog as any);
  const postVisibility = new PostVisibilityReadService(prisma, stubAppConfig, stubViewerContext as any);
  const query = new NotificationQueryService(prisma, stubAppConfig, postVisibility, readState);
  const writer = new NotificationWriterService(prisma, stubPresenceRealtime as any, stubPresenceRedis as any, stubJobs as any, push, query, readState);
  const svc = new NotificationsService(preferences, push, apnsPush, readState, query, writer);
  return { svc, prisma, push };
}

// ---------------------------------------------------------------------------
// fanOutStatusUpdateNotifications
// ---------------------------------------------------------------------------

describe('fanOutStatusUpdateNotifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a notification to each follower', async () => {
    const followers = [
      { followerId: 'follower-1' },
      { followerId: 'follower-2' },
    ];
    const { svc, prisma } = buildServices({
      follow: { findMany: jest.fn(async () => followers) },
    });

    await svc.fanOutStatusUpdateNotifications({ actorUserId: 'actor-1', text: 'Feeling great!' });

    // one upsert call per follower (via $transaction)
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does not notify the actor themselves', async () => {
    const followers = [
      { followerId: 'actor-1' }, // self
      { followerId: 'follower-1' },
    ];
    const { svc, prisma } = buildServices({
      follow: { findMany: jest.fn(async () => followers) },
    });

    await svc.fanOutStatusUpdateNotifications({ actorUserId: 'actor-1', text: 'Self check' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the actor has no followers', async () => {
    const { svc, prisma } = buildServices({
      follow: { findMany: jest.fn(async () => []) },
    });

    await svc.fanOutStatusUpdateNotifications({ actorUserId: 'actor-1', text: 'No followers' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertStatusUpdateNotification – cooldown behaviour
// ---------------------------------------------------------------------------

describe('upsertStatusUpdateNotification – cooldown', () => {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  beforeEach(() => jest.clearAllMocks());

  function buildWithExisting(existingCreatedAt: Date | null) {
    const notif = existingCreatedAt
      ? { id: 'existing-notif', createdAt: existingCreatedAt, deliveredAt: null, readAt: null }
      : null;

    const sendKindPushSpy = jest.fn(async () => {});
    const { svc, prisma, push } = buildServices({
      notification: {
        findFirst: jest.fn(async () => notif),
        create: jest.fn(async () => ({ id: 'new-notif' })),
        update: jest.fn(async () => ({})),
        count: jest.fn(async () => 1),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    });
    jest.spyOn(push, 'sendKindPushForActor').mockImplementation(sendKindPushSpy);
    return { svc, prisma, sendKindPushSpy };
  }

  it('creates notification and sends push when no existing row', async () => {
    const { svc, prisma, sendKindPushSpy } = buildWithExisting(null);

    await svc['writer'].upsertStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Fresh status',
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    // Allow micro-tick for fire-and-forget push
    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledTimes(1);
    expect(sendKindPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status_update', recipientUserId: 'r1' }),
    );
  });

  it('updates row silently (no push, no bell) when inside the 6h cooldown', async () => {
    const recentCreatedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const { svc, prisma, sendKindPushSpy } = buildWithExisting(recentCreatedAt);

    await svc['writer'].upsertStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Updated status',
    });

    expect(prisma.notification.update).toHaveBeenCalledTimes(1);
    // update should NOT nullify deliveredAt/readAt
    const updateArgs = prisma.notification.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('deliveredAt');
    expect(prisma.user.update).not.toHaveBeenCalled(); // no bell increment
    await new Promise(setImmediate);
    expect(sendKindPushSpy).not.toHaveBeenCalled();
  });

  it('renotifies (push + bell) after the 6h cooldown expires', async () => {
    const oldCreatedAt = new Date(Date.now() - SIX_HOURS_MS - 60_000); // just past cooldown
    const { svc, prisma, sendKindPushSpy } = buildWithExisting(oldCreatedAt);

    await svc['writer'].upsertStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Status after cooldown',
    });

    expect(prisma.notification.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.notification.update.mock.calls[0][0];
    expect(updateArgs.data).toHaveProperty('deliveredAt', null);
    expect(updateArgs.data).toHaveProperty('readAt', null);
    expect(prisma.user.update).toHaveBeenCalledTimes(1); // bell increment
    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledTimes(1);
  });

  it('never notifies the actor about themselves', async () => {
    const { svc, sendKindPushSpy } = buildWithExisting(null);

    await svc['writer'].upsertStatusUpdateNotification({
      recipientUserId: 'actor-self',
      actorUserId: 'actor-self',
      actorUsername: 'actor-user',
      text: 'Should be no-op',
    });

    await new Promise(setImmediate);
    expect(sendKindPushSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shouldSendPushForKind – status_update gates on pushFollowedPost
// ---------------------------------------------------------------------------

describe('NotificationPushService.shouldSendPushForKind for status_update', () => {
  it('returns true when pushFollowedPost is true', () => {
    const prefs = makeDefaultPrefs();
    const { push } = buildServices({});
    expect(push.shouldSendPushForKind(prefs, 'status_update')).toBe(true);
  });

  it('returns false when pushFollowedPost is false', () => {
    const prefs = { ...makeDefaultPrefs(), pushFollowedPost: false };
    const { push } = buildServices({});
    expect(push.shouldSendPushForKind(prefs, 'status_update')).toBe(false);
  });
});
