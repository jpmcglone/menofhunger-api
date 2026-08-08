/**
 * Unit tests for status_update notification fan-out.
 *
 * Contract: a NEW status (mode 'created') always writes a NEW notification row per
 * follower — bell + push every time, no cooldown. Editing the active status
 * (mode 'edited') patches the latest existing row in place — no new row, no bell,
 * no push.
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
    pushReplyNudge: true, pushCrewStreak: true, pushGroupActivity: true, pushDailyContent: true, pushCheckinReminder: true,
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

  const noopCache: any = {
    getOrSetJson: async ({ compute }: any) => compute(),
    getOrSetNullableJson: async ({ compute }: any) => compute(),
    setJson: async () => {},
    del: async () => {},
  };
  const preferences = new NotificationPreferencesService(prisma, noopCache);
  const apnsPush = new ApnsPushService(prisma, stubAppConfig, noopCache);
  const push = new NotificationPushService(prisma, stubAppConfig, stubPresence as any, preferences, apnsPush, noopCache);
  const readState = new NotificationReadStateService(prisma, stubPresenceRealtime as any, stubPosthog as any);
  const postVisibility = new PostVisibilityReadService(prisma, stubAppConfig, stubViewerContext as any);
  const query = new NotificationQueryService(prisma, stubAppConfig, postVisibility, readState);
  // Stands in for the side-effects worker: runs the push handler inline so these tests keep
  // asserting the real push payload (url, coalesce tag) through the new dispatch seam.
  const sideEffects = {
    dispatch: (name: string, payload: any) => {
      if (name === 'notification.push') void push.sendKindPushForActor(payload);
    },
  } as any;
  const writer = new NotificationWriterService(prisma, stubPresenceRealtime as any, stubPresenceRedis as any, stubJobs as any, sideEffects, query, readState);
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

    await svc.fanOutStatusUpdateNotifications({
      actorUserId: 'actor-1',
      text: 'Feeling great!',
      postId: null,
      mode: 'created',
    });

    // one create call per follower (via $transaction)
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

    await svc.fanOutStatusUpdateNotifications({
      actorUserId: 'actor-1',
      text: 'Self check',
      postId: null,
      mode: 'created',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the actor has no followers', async () => {
    const { svc, prisma } = buildServices({
      follow: { findMany: jest.fn(async () => []) },
    });

    await svc.fanOutStatusUpdateNotifications({
      actorUserId: 'actor-1',
      text: 'No followers',
      postId: null,
      mode: 'created',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createStatusUpdateNotification – every new status is its own notification
// ---------------------------------------------------------------------------

describe('createStatusUpdateNotification', () => {
  beforeEach(() => jest.clearAllMocks());

  function build(existing: { id: string } | null = null) {
    const sendKindPushSpy = jest.fn(async () => {});
    const { svc, prisma, push } = buildServices({
      notification: {
        findFirst: jest.fn(async () => existing),
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

  it('creates a row, increments the bell, and pushes', async () => {
    const { svc, prisma, sendKindPushSpy } = build();

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Fresh status',
      postId: null,
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledTimes(1); // bell increment
    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status_update', recipientUserId: 'r1' }),
    );
  });

  it('emits a non-silent event so clients announce the arrival', async () => {
    const { svc } = build();
    stubPresenceRealtime.emitNotificationNew.mockClear();
    jest
      .spyOn(svc['query'], 'buildNotificationDtoForRecipient')
      .mockResolvedValue({ id: 'new-notif' } as any);

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Fresh status',
      postId: null,
    });

    const [, payload] = stubPresenceRealtime.emitNotificationNew.mock.calls[0];
    expect(payload.silent).toBeUndefined();
    expect(stubPresenceRealtime.emitNotificationsUpdated).toHaveBeenCalled();
  });

  it('creates a NEW row even when an earlier status notification exists', async () => {
    const { svc, prisma, sendKindPushSpy } = build({ id: 'older-status-notif' });

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'Second status today',
      postId: 'post-2',
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.update).not.toHaveBeenCalled(); // never reuses the old row
    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledTimes(1);
  });

  it('deep-links the push to the status post when one exists', async () => {
    const { svc, sendKindPushSpy } = build();

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'With a post',
      postId: 'post-abc',
    });

    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledWith(expect.objectContaining({ url: '/p/post-abc' }));
  });

  it('falls back to the profile when the status made no post', async () => {
    const { svc, sendKindPushSpy } = build();

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      actorUsername: 'actor-user',
      text: 'No post',
      postId: null,
    });

    await new Promise(setImmediate);
    expect(sendKindPushSpy).toHaveBeenCalledWith(expect.objectContaining({ url: '/u/actor-user' }));
  });

  it('never notifies the actor about themselves', async () => {
    const { svc, prisma, sendKindPushSpy } = build();

    await svc['writer'].createStatusUpdateNotification({
      recipientUserId: 'actor-self',
      actorUserId: 'actor-self',
      actorUsername: 'actor-user',
      text: 'Should be no-op',
      postId: null,
    });

    expect(prisma.notification.create).not.toHaveBeenCalled();
    await new Promise(setImmediate);
    expect(sendKindPushSpy).not.toHaveBeenCalled();
  });

  /**
   * Notifications are one-row-per-status, but pushes must still coalesce so a burst of
   * statuses doesn't buzz followers repeatedly. Coalescing keys off the resolved push tag,
   * and `buildPushTag` prefers subjectPostId over subjectUserId — so passing subjectPostId
   * here would give every status its own tag and silently disable coalescing entirely.
   */
  it('keeps the push coalesce tag actor-scoped so a burst of statuses collapses', async () => {
    const sendKindPushSpy = jest.fn(async (_args: any) => {});
    const { svc, push } = buildServices({});
    jest.spyOn(push, 'sendKindPushForActor').mockImplementation(sendKindPushSpy);

    for (const postId of ['post-1', 'post-2']) {
      await svc['writer'].createStatusUpdateNotification({
        recipientUserId: 'r1',
        actorUserId: 'a1',
        actorUsername: 'actor-user',
        text: `Status for ${postId}`,
        postId,
      });
    }
    await new Promise(setImmediate);

    expect(sendKindPushSpy).toHaveBeenCalledTimes(2);
    const tags = sendKindPushSpy.mock.calls.map(([args]) =>
      push.buildPushTag({
        recipientUserId: args.recipientUserId,
        kind: args.kind,
        actorUserId: args.actorUserId,
        subjectPostId: args.subjectPostId ?? null,
        subjectUserId: args.subjectUserId ?? null,
      }),
    );
    expect(tags[0]).toBe('notif-status_update-user-a1');
    expect(tags[1]).toBe(tags[0]);
  });
});

// ---------------------------------------------------------------------------
// patchStatusUpdateNotification – editing a status is silent
// ---------------------------------------------------------------------------

describe('patchStatusUpdateNotification', () => {
  beforeEach(() => jest.clearAllMocks());

  function build(existing: { id: string } | null) {
    const sendKindPushSpy = jest.fn(async () => {});
    const { svc, prisma, push } = buildServices({
      notification: {
        findFirst: jest.fn(async () => existing),
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

  it('patches the latest row in place with no bell and no push', async () => {
    const { svc, prisma, sendKindPushSpy } = build({ id: 'existing-notif' });

    await svc['writer'].patchStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      text: 'Edited text',
      postId: 'post-1',
    });

    expect(prisma.notification.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.notification.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'existing-notif' });
    expect(updateArgs.data).toMatchObject({ body: 'Edited text' });
    // Unread state is untouched — an edit must not resurface the notification.
    expect(updateArgs.data).not.toHaveProperty('deliveredAt');
    expect(updateArgs.data).not.toHaveProperty('readAt');
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    await new Promise(setImmediate);
    expect(sendKindPushSpy).not.toHaveBeenCalled();
  });

  it('marks the realtime emit silent so clients skip the sound and badge', async () => {
    const { svc } = build({ id: 'existing-notif' });
    stubPresenceRealtime.emitNotificationNew.mockClear();
    jest
      .spyOn(svc['query'], 'buildNotificationDtoForRecipient')
      .mockResolvedValue({ id: 'existing-notif' } as any);

    await svc['writer'].patchStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      text: 'Edited text',
      postId: null,
    });

    expect(stubPresenceRealtime.emitNotificationNew).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ silent: true }),
    );
    // A silent patch must never touch the bell count.
    expect(stubPresenceRealtime.emitNotificationsUpdated).not.toHaveBeenCalled();
  });

  it('is a no-op when the recipient has no status notification to patch', async () => {
    const { svc, prisma } = build(null);

    await svc['writer'].patchStatusUpdateNotification({
      recipientUserId: 'r1',
      actorUserId: 'a1',
      text: 'Edited text',
      postId: null,
    });

    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
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
