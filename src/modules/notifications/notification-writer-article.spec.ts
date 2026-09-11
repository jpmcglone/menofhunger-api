import { NotificationWriterService } from './notification-writer.service';

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

function makeDeps() {
  const notifCreate = jest.fn(async (args: { data: unknown }) => ({ id: 'notif-new', ...(args.data as object) }));
  const notifCount = jest.fn(async () => 1);
  const notifFindFirst = jest.fn(async () => null);
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
    sideEffects,
  };
}

describe('NotificationWriterService article click-through URLs', () => {
  it('sends followed-article pushes to the article', async () => {
    const { writer, sideEffects } = makeDeps();

    await writer.create({
      recipientUserId: 'user-1',
      kind: 'followed_article',
      actorUserId: 'author-1',
      subjectArticleId: 'article-1',
    });

    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'notification.push',
      expect.objectContaining({ url: '/a/article-1', subjectArticleId: 'article-1' }),
    );
  });

  it('sends article comment pushes to the comment hash', async () => {
    const { writer, sideEffects } = makeDeps();

    await writer.create({
      recipientUserId: 'user-1',
      kind: 'comment',
      actorUserId: 'actor-1',
      subjectArticleId: 'article-1',
      subjectArticleCommentId: 'c9',
      title: 'replied to your article',
    });

    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'notification.push',
      expect.objectContaining({
        url: '/a/article-1#comment-c9',
        subjectArticleId: 'article-1',
      }),
    );
  });
});
