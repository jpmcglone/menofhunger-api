import { NotificationWriterService } from './notification-writer.service';

/**
 * Focused tests for the daily-content (word_of_the_day / quote_of_the_day)
 * fan-out deduplication logic.
 *
 * Invariant: each user ends up with at most ONE notification of each daily-content
 * kind. Old rows are deleted before the new row is created, and the undelivered
 * bell counter is incremented only for users who did NOT already have an unread
 * row (so replacing an unread row with a new one is net-zero on the counter).
 */

type MockPrisma = {
  dailyContentSnapshot: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  user: { findMany: jest.Mock; update: jest.Mock };
  notification: {
    findMany: jest.Mock;
    deleteMany: jest.Mock;
    createMany: jest.Mock;
  };
  $executeRaw: jest.Mock;
};

function makeService(): { service: NotificationWriterService; prisma: MockPrisma; sideEffects: { dispatch: jest.Mock } } {
  const prisma: MockPrisma = {
    dailyContentSnapshot: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    notification: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
  };

  const presenceRealtime = { emitNotificationsUpdated: jest.fn() };
  const presenceRedis = { isOnline: jest.fn().mockResolvedValue(false) };
  const jobs = { dispatch: jest.fn() };
  const sideEffects = { dispatch: jest.fn() };
  const query = { getOne: jest.fn() };
  const readState = {
    undeliveredBellWhere: jest.fn((userId: string) => ({ recipientUserId: userId, deliveredAt: null })),
  };

  const service = new NotificationWriterService(
    prisma as never,
    presenceRealtime as never,
    presenceRedis as never,
    jobs as never,
    sideEffects as never,
    query as never,
    readState as never,
  );

  return { service, prisma, sideEffects };
}

const baseSnap = {
  websters1828: { word: 'Overmuch' },
  quote: { author: 'Thomas Carlyle', text: 'Do the thing before you.' },
  wordNotifiedAt: null,
  quoteNotifiedAt: null,
  wordFanoutCursor: null,
  quoteFanoutCursor: null,
};

describe('fanOutDailyContentNotifications – deduplication', () => {
  it('deletes prior rows before creating the new word notification', async () => {
    const { service, prisma } = makeService();

    prisma.dailyContentSnapshot.findUnique.mockResolvedValue(baseSnap);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }])
      .mockResolvedValue([]);
    prisma.notification.findMany.mockResolvedValue([]);

    await service.fanOutDailyContentNotifications({ item: 'word', dayKey: '2026-08-03' });

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { kind: 'word_of_the_day', recipientUserId: { in: ['u1', 'u2'] } },
    });
    expect(prisma.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ kind: 'word_of_the_day', recipientUserId: 'u1' }),
          expect.objectContaining({ kind: 'word_of_the_day', recipientUserId: 'u2' }),
        ]),
      }),
    );
  });

  it('increments bell counter only for users who had no unread row', async () => {
    const { service, prisma } = makeService();

    prisma.dailyContentSnapshot.findUnique.mockResolvedValue(baseSnap);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }])
      .mockResolvedValue([]);
    // u1 already has an unread row; u2 and u3 do not
    prisma.notification.findMany.mockResolvedValue([{ recipientUserId: 'u1' }]);

    await service.fanOutDailyContentNotifications({ item: 'word', dayKey: '2026-08-03' });

    // $executeRaw is called as a tagged template. Jest captures it as (strings, ...values).
    // The SQL fragment is strings[0]; the user-id array is the first value arg.
    const incrementCall = prisma.$executeRaw.mock.calls.find((args: unknown[]) => {
      const strings = args[0] as readonly string[];
      return Array.isArray(strings) && strings[0]?.includes('undeliveredNotificationCount');
    });
    expect(incrementCall).toBeDefined();
    const boundUserIds: string[] = incrementCall![1] as string[];
    expect(boundUserIds).toEqual(expect.arrayContaining(['u2', 'u3']));
    expect(boundUserIds).not.toContain('u1');
  });

  it('skips all counter increments when every user already had an unread row', async () => {
    const { service, prisma } = makeService();

    prisma.dailyContentSnapshot.findUnique.mockResolvedValue(baseSnap);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValue([]);
    prisma.notification.findMany.mockResolvedValue([{ recipientUserId: 'u1' }]);

    await service.fanOutDailyContentNotifications({ item: 'word', dayKey: '2026-08-03' });

    const incrementCalls = prisma.$executeRaw.mock.calls.filter((args: unknown[]) => {
      const strings = args[0] as readonly string[];
      return Array.isArray(strings) && strings[0]?.includes('undeliveredNotificationCount');
    });
    expect(incrementCalls).toHaveLength(0);
  });

  it('decrements counter by (N-1) when user had N > 1 unread rows', async () => {
    const { service, prisma } = makeService();

    prisma.dailyContentSnapshot.findUnique.mockResolvedValue(baseSnap);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValue([]);
    // u1 had 3 stale unread rows — counter is inflated by 2 and must be corrected
    prisma.notification.findMany.mockResolvedValue([
      { recipientUserId: 'u1' },
      { recipientUserId: 'u1' },
      { recipientUserId: 'u1' },
    ]);

    await service.fanOutDailyContentNotifications({ item: 'word', dayKey: '2026-08-03' });

    // No increment (had unread rows)
    const incrementCalls = prisma.$executeRaw.mock.calls.filter((args: unknown[]) => {
      const strings = args[0] as readonly string[];
      return Array.isArray(strings) && strings[0]?.includes('undeliveredNotificationCount');
    });
    expect(incrementCalls).toHaveLength(0);

    // Decrement by excess = 3 - 1 = 2
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { undeliveredNotificationCount: { decrement: 2 } },
      }),
    );
  });

  it('works the same way for quote_of_the_day', async () => {
    const { service, prisma } = makeService();

    prisma.dailyContentSnapshot.findUnique.mockResolvedValue(baseSnap);
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u1' }])
      .mockResolvedValue([]);
    prisma.notification.findMany.mockResolvedValue([]);

    await service.fanOutDailyContentNotifications({ item: 'quote', dayKey: '2026-08-03' });

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { kind: 'quote_of_the_day', recipientUserId: { in: ['u1'] } },
    });
    expect(prisma.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ kind: 'quote_of_the_day', recipientUserId: 'u1' }),
        ]),
      }),
    );
  });
});
