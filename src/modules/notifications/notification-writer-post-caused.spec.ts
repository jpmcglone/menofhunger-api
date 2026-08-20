import { NotificationWriterService } from './notification-writer.service';

/**
 * Invariant: a recipient gets at most one post-shaped notification (comment /
 * mention / followed_post / checkin_post) per causing post. Retries and
 * comment+followed_post overlap must not write a second row, bump the bell,
 * or dispatch a push.
 */

function buildWriter(prisma: object, presenceRealtime: object, sideEffects: object): NotificationWriterService {
  return new NotificationWriterService(
    prisma as never,
    presenceRealtime as never,
    { isOnline: jest.fn(async () => false), isIdle: jest.fn(async () => false) } as never,
    { enqueueCron: jest.fn() } as never,
    sideEffects as never,
    { buildNotificationDtoForRecipient: jest.fn(async () => null) } as never,
    {
      emitWaitingCountForUser: jest.fn(),
      undeliveredBellWhere: (uid: string) => ({ recipientUserId: uid, deliveredAt: null }),
    } as never,
  );
}

function makeDeps(existing: { id: string } | null = null) {
  const notifCreate = jest.fn(async (args: { data: unknown }) => ({ id: 'notif-new', ...(args.data as object) }));
  const notifCount = jest.fn(async () => 1);
  const notifFindFirst = jest.fn(async () => existing);
  const userUpdate = jest.fn(async () => ({}));
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      notification: { create: notifCreate, count: notifCount, findFirst: notifFindFirst },
      user: { update: userUpdate },
    };
    return fn(tx);
  });
  const presenceRealtime = { emitNotificationsUpdated: jest.fn(), emitNotificationNew: jest.fn() };
  const sideEffects = { dispatch: jest.fn() };
  const prisma = {
    $transaction,
    notification: { create: notifCreate, count: notifCount, findFirst: notifFindFirst },
    user: { update: userUpdate },
    userPageOperator: { findUnique: jest.fn(async () => null) },
  };

  return {
    writer: buildWriter(prisma, presenceRealtime, sideEffects),
    prisma,
    presenceRealtime,
    sideEffects,
  };
}

describe('NotificationWriterService — post-caused create is idempotent', () => {
  it('creates a comment notification when none exists for that post', async () => {
    const { writer, prisma, presenceRealtime, sideEffects } = makeDeps(null);

    await writer.create({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      actorPostId: 'reply-1',
      subjectPostId: 'parent-1',
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(presenceRealtime.emitNotificationsUpdated).toHaveBeenCalled();
    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'notification.push',
      expect.objectContaining({ recipientUserId: 'user-1', kind: 'comment' }),
    );
  });

  it('skips a second comment for the same recipient and reply', async () => {
    const { writer, prisma, presenceRealtime, sideEffects } = makeDeps({ id: 'notif-existing' });

    await writer.create({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      actorPostId: 'reply-1',
      subjectPostId: 'parent-1',
    });

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(presenceRealtime.emitNotificationsUpdated).not.toHaveBeenCalled();
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
  });

  it('skips followed_post when a comment already exists for the same reply', async () => {
    const { writer, prisma, presenceRealtime, sideEffects } = makeDeps({ id: 'notif-comment' });

    await writer.create({
      recipientUserId: 'user-1',
      kind: 'followed_post',
      actorUserId: 'actor-1',
      actorPostId: 'reply-1',
      subjectPostId: 'reply-1',
    });

    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(presenceRealtime.emitNotificationsUpdated).not.toHaveBeenCalled();
    expect(sideEffects.dispatch).not.toHaveBeenCalled();
  });
});
