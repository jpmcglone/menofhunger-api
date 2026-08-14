import { NotificationWriterService } from './notification-writer.service';

function buildWriter(overrides: {
  findFirst?: unknown;
  dto?: unknown;
} = {}) {
  const prisma = {
    notification: {
      findFirst: jest.fn(async () => overrides.findFirst ?? null),
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(),
    space: { findUnique: jest.fn() },
    user: { update: jest.fn() },
  };
  const presenceRealtime = {
    emitNotificationNew: jest.fn(),
    emitNotificationsUpdated: jest.fn(),
  };
  const query = {
    buildNotificationDtoForRecipient: jest.fn(async () => overrides.dto ?? { id: 'n1' }),
  };
  const writer = new NotificationWriterService(
    prisma as any,
    presenceRealtime as any,
    { isOnline: jest.fn(async () => false), isIdle: jest.fn(async () => false) } as any,
    { enqueueCron: jest.fn() } as any,
    { dispatch: jest.fn() } as any,
    query as any,
    { undeliveredBellWhere: () => ({}), emitWaitingCountForUser: jest.fn() } as any,
  );
  return { writer, prisma, presenceRealtime, query };
}

const BASE = {
  recipientUserId: 'sub-1',
  kind: 'space_live' as const,
  spaceId: 'space-1',
  actorUserId: 'owner-1',
  title: "ocaptain's space was live",
  body: "It's no longer live.",
};

describe('upsertSpaceScheduleNotification quiet patch', () => {
  it('rewrites copy in place, emits silent, and does not push', async () => {
    const { writer, prisma, presenceRealtime } = buildWriter({
      findFirst: { id: 'n1' },
      dto: { id: 'n1', title: BASE.title },
    });
    const sideEffectsDispatch = (writer as any).sideEffects.dispatch as jest.Mock;

    await writer.upsertSpaceScheduleNotification({ ...BASE, resurface: false });

    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: {
        title: BASE.title,
        body: BASE.body,
        actorUserId: 'owner-1',
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(presenceRealtime.emitNotificationNew).toHaveBeenCalledWith(
      'sub-1',
      expect.objectContaining({ silent: true, notification: expect.objectContaining({ id: 'n1' }) }),
    );
    expect(sideEffectsDispatch).not.toHaveBeenCalled();
  });

  it('no-ops quietly when no space_live row exists', async () => {
    const { writer, prisma, presenceRealtime } = buildWriter({ findFirst: null });

    await writer.upsertSpaceScheduleNotification({ ...BASE, resurface: false });

    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(presenceRealtime.emitNotificationNew).not.toHaveBeenCalled();
  });
});
