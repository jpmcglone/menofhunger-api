/**
 * Tests for presentAt stamping in NotificationWriterService.
 *
 * Verifies that `presentAt` is set when the recipient is actively present
 * (online + not idle) at create time, and null otherwise.
 */
import { NotificationWriterService } from './notification-writer.service';
import { NotificationPushService } from './notification-push.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationReadStateService } from './notification-read-state.service';

type Deps = {
  presenceRedis: { isOnline: jest.Mock; isIdle: jest.Mock };
  presenceRealtime: { emitNotificationsUpdated: jest.Mock; emitNotificationNew: jest.Mock };
  jobs: { enqueueCron: jest.Mock };
  prisma: {
    $transaction: jest.Mock;
    notification: { create: jest.Mock; count: jest.Mock; findFirst: jest.Mock };
    user: { update: jest.Mock };
  };
};

function buildWriter(deps: Deps): NotificationWriterService {
  const push = { sendKindPushForActor: jest.fn() } as unknown as NotificationPushService;
  const query = { buildNotificationDtoForRecipient: jest.fn(async () => null) } as unknown as NotificationQueryService;
  const readState = { emitWaitingCountForUser: jest.fn() } as unknown as NotificationReadStateService;
  return new NotificationWriterService(
    deps.prisma as any,
    deps.presenceRealtime as any,
    deps.presenceRedis as any,
    deps.jobs as any,
    push,
    query,
    readState,
  );
}

function makeDeps(overrides?: { online?: boolean; idle?: boolean }): Deps {
  const isOnline = jest.fn(async () => overrides?.online ?? false);
  const isIdle = jest.fn(async () => overrides?.idle ?? false);

  const notifCreate = jest.fn(async (args: any) => ({ id: 'notif-1', ...args.data }));
  const notifCount = jest.fn(async () => 1);
  const notifFindFirst = jest.fn(async () => null);
  const userUpdate = jest.fn(async () => ({}));

  // Simulate prisma.$transaction by running the callback with a tx that mirrors the mocked methods.
  const $transaction = jest.fn(async (fn: (tx: any) => Promise<any>) => {
    const tx = {
      notification: { create: notifCreate, count: notifCount, findFirst: notifFindFirst },
      user: { update: userUpdate },
    };
    return fn(tx);
  });

  return {
    presenceRedis: { isOnline, isIdle },
    presenceRealtime: { emitNotificationsUpdated: jest.fn(), emitNotificationNew: jest.fn() },
    jobs: { enqueueCron: jest.fn(async () => undefined) },
    prisma: { $transaction, notification: { create: notifCreate, count: notifCount, findFirst: notifFindFirst }, user: { update: userUpdate } },
  };
}

describe('NotificationWriterService – presentAt stamping', () => {
  describe('create()', () => {
    it('sets presentAt when recipient is online and not idle', async () => {
      const deps = makeDeps({ online: true, idle: false });
      const writer = buildWriter(deps);

      const before = new Date();
      await writer.create({ recipientUserId: 'user-1', kind: 'follow' });
      const after = new Date();

      const [createCall] = deps.prisma.notification.create.mock.calls;
      const { presentAt } = createCall[0].data;
      expect(presentAt).toBeInstanceOf(Date);
      expect(presentAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(presentAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('leaves presentAt undefined when recipient is offline', async () => {
      const deps = makeDeps({ online: false });
      const writer = buildWriter(deps);

      await writer.create({ recipientUserId: 'user-1', kind: 'follow' });

      const [createCall] = deps.prisma.notification.create.mock.calls;
      expect(createCall[0].data.presentAt).toBeUndefined();
    });

    it('leaves presentAt undefined when recipient is idle', async () => {
      const deps = makeDeps({ online: true, idle: true });
      const writer = buildWriter(deps);

      await writer.create({ recipientUserId: 'user-1', kind: 'follow' });

      const [createCall] = deps.prisma.notification.create.mock.calls;
      expect(createCall[0].data.presentAt).toBeUndefined();
    });

    it('does not block notification creation when presence check throws', async () => {
      const deps = makeDeps();
      deps.presenceRedis.isOnline.mockRejectedValue(new Error('Redis down'));
      const writer = buildWriter(deps);

      await expect(writer.create({ recipientUserId: 'user-1', kind: 'follow' })).resolves.not.toThrow();

      const [createCall] = deps.prisma.notification.create.mock.calls;
      // presentAt should be undefined (null fallback), not throw
      expect(createCall[0].data.presentAt).toBeUndefined();
    });

    it('does not set presentAt when actor === recipient (self-notification guard)', async () => {
      const deps = makeDeps({ online: true, idle: false });
      const writer = buildWriter(deps);

      // self-notifications are dropped before any DB call
      await writer.create({ recipientUserId: 'user-1', kind: 'follow', actorUserId: 'user-1' });

      expect(deps.prisma.notification.create).not.toHaveBeenCalled();
    });
  });
});
