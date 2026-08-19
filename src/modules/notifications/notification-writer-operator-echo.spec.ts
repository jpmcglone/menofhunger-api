import { NotificationWriterService } from './notification-writer.service';

function makeService() {
  const prisma = {
    userPageOperator: {
      findUnique: jest.fn().mockResolvedValue(null) as jest.Mock,
      findMany: jest.fn(async () => []),
    },
    notification: { create: jest.fn() },
  };
  const service = new NotificationWriterService(
    prisma as never,
    { emitNotificationsUpdated: jest.fn() } as never,
    { isOnline: jest.fn().mockResolvedValue(false) } as never,
    { dispatch: jest.fn() } as never,
    { dispatch: jest.fn() } as never,
    { getOne: jest.fn() } as never,
    { undeliveredBellWhere: jest.fn() } as never,
  );
  return { service, prisma };
}

describe('NotificationWriterService — operator self-echo', () => {
  it('skips followed_post when the recipient operates the actor page', async () => {
    const { service, prisma } = makeService();
    prisma.userPageOperator.findUnique.mockResolvedValue({ operatorUserId: 'john' });

    await expect(
      service.create({
        recipientUserId: 'john',
        kind: 'followed_post',
        actorUserId: 'page-1',
      }),
    ).resolves.toBeUndefined();

    expect(prisma.userPageOperator.findUnique).toHaveBeenCalledWith({
      where: {
        operatorUserId_pageUserId: { operatorUserId: 'john', pageUserId: 'page-1' },
      },
      select: { operatorUserId: true },
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('skips status_update when the recipient operates the actor page', async () => {
    const { service, prisma } = makeService();
    prisma.userPageOperator.findUnique.mockResolvedValue({ operatorUserId: 'john' });

    await service.createStatusUpdateNotification({
      recipientUserId: 'john',
      actorUserId: 'page-1',
      actorUsername: 'menofhunger',
      text: 'Posted as the page',
      postId: 'post-1',
    });

    expect(prisma.notification.create).not.toHaveBeenCalled();
  });
});
