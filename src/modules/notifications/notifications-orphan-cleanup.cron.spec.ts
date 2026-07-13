import { NotificationsOrphanCleanupCron } from './notifications-orphan-cleanup.cron';

describe('NotificationsOrphanCleanupCron', () => {
  it('excludes dedicated-badge notification kinds from bell-counter decrements', async () => {
    const groupBy = jest.fn(async () => []);
    const prisma = {
      notification: {
        groupBy,
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      user: { update: jest.fn() },
    } as any;
    const cron = new NotificationsOrphanCleanupCron(
      prisma,
      { enqueueCron: jest.fn() } as any,
      { runSchedulers: jest.fn(() => true) } as any,
    );

    await cron.runCleanupDeletedPostNotifications();

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deliveredAt: null,
          kind: { notIn: ['message', 'community_group_post'] },
        }),
      }),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
