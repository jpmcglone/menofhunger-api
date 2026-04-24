import { NotificationsService } from './notifications.service';

function makeService(overrides?: { prisma?: any }) {
  const prisma =
    overrides?.prisma ??
    ({
      notification: { findUnique: jest.fn(), findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
      post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
      user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 0 })) },
      follow: { findMany: jest.fn(async () => []) },
      userBlock: { findMany: jest.fn(async () => []) },
    } as any);

  const appConfig = { r2: jest.fn(() => null) } as any;
  const presenceRealtime = {
    emitNotificationsDeleted: jest.fn(),
    emitNotificationsUpdated: jest.fn(),
    emitNotificationNew: jest.fn(),
  } as any;
  const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;
  const posthog = { capture: jest.fn() } as any;
  const viewerContextService = { getViewer: jest.fn(async () => null) } as any;

  const svc = new NotificationsService(prisma, appConfig, presenceRealtime, jobs, posthog, viewerContextService);
  return { svc, prisma };
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

    // Batch post/user loads (not per notification).
    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);

    // No per-notification loads.
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
    // notification.findUnique is allowed only for cursor lookup; cursor is null in this test.
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();

    // Ensure list() doesn't fall back to per-notification builder.
    expect(buildSpy).not.toHaveBeenCalled();
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

