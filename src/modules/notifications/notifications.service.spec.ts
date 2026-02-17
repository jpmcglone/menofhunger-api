import { NotificationsService } from './notifications.service';

function makeService(overrides?: { prisma?: any }) {
  const prisma =
    overrides?.prisma ??
    ({
      notification: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
      post: { findMany: jest.fn(async () => []), findUnique: jest.fn() },
      user: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => ({ undeliveredNotificationCount: 0 })) },
      follow: { findMany: jest.fn(async () => []) },
    } as any);

  const appConfig = { r2: jest.fn(() => null) } as any;
  const presenceRealtime = {
    emitNotificationsDeleted: jest.fn(),
    emitNotificationsUpdated: jest.fn(),
    emitNotificationNew: jest.fn(),
  } as any;
  const jobs = { enqueueCron: jest.fn(async () => undefined) } as any;

  const svc = new NotificationsService(prisma, appConfig, presenceRealtime, jobs);
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

