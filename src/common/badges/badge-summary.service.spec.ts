import { BadgeSummaryService } from './badge-summary.service';

function fixture() {
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ accountKind: 'person', bannedAt: null, undeliveredGroupPostCount: 3 })) },
    userBlock: { findMany: jest.fn(async () => [{ blockerId: 'viewer', blockedId: 'blocked' }]) },
    userMute: { findMany: jest.fn(async () => [{ mutedId: 'muted' }]) },
    notification: {
      count: jest.fn(async (args?: any): Promise<number> => (args?.where.kind === 'mention' ? 1 : 2)),
      findFirst: jest.fn(async (): Promise<{ id: string } | null> => ({ id: 'unread' })),
    },
    communityGroupInvite: { count: jest.fn(async () => 4) },
    userPageOperator: { findMany: jest.fn(async () => [{ pageUserId: 'page' }, { pageUserId: 'page' }]) },
    $queryRaw: jest.fn(async () => [{ count: 5 }]),
  };
  return { prisma, service: new BadgeSummaryService(prisma as any, { personalCount: jest.fn().mockResolvedValue(0) } as any) };
}

describe('BadgeSummaryService', () => {
  it('sums bell, board mentions, groups, pending invites and messages independently of unread existence', async () => {
    const { prisma, service } = fixture();
    await expect(service.forIdentity('viewer')).resolves.toEqual({ unreadBadgeCount: 15, hasUnreadNotifications: true, hasUnreadBoard: true });
    prisma.notification.findFirst.mockResolvedValue(null);
    await expect(service.forIdentity('viewer')).resolves.toEqual({ unreadBadgeCount: 15, hasUnreadNotifications: false, hasUnreadBoard: false });
    expect(prisma.communityGroupInvite.count).toHaveBeenCalledWith({ where: { inviteeUserId: 'viewer', status: 'pending', expiresAt: { gt: expect.any(Date) }, group: { deletedAt: null } } });
  });

  it('keeps an unread dot with zero numeric counts, then clears after the final read', async () => {
    const { prisma, service } = fixture();
    prisma.notification.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue({ accountKind: 'person', bannedAt: null, undeliveredGroupPostCount: 0 });
    prisma.communityGroupInvite.count.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);
    await expect(service.forIdentity('viewer')).resolves.toEqual({ unreadBadgeCount: 0, hasUnreadNotifications: true, hasUnreadBoard: true });
    prisma.notification.findFirst.mockResolvedValue(null);
    await expect(service.forIdentity('viewer')).resolves.toEqual({ unreadBadgeCount: 0, hasUnreadNotifications: false, hasUnreadBoard: false });
  });

  it('keeps Board activity out of the bell count and dot', async () => {
    const { prisma, service } = fixture();
    await service.forIdentity('viewer');
    const [bellCall] = prisma.notification.count.mock.calls[0] as unknown as [any];
    expect(bellCall.where.AND[1]).toEqual({ NOT: expect.objectContaining({ kind: { in: ['comment', 'mention', 'followed_post'] } }) });
    const [dotCall] = prisma.notification.findFirst.mock.calls[0] as unknown as [any];
    expect(dotCall.where.AND[1]).toHaveProperty('NOT');
  });

  it('excludes hidden actors and person-only notifications from page summaries', async () => {
    const { prisma, service } = fixture();
    prisma.user.findUnique.mockResolvedValue({ accountKind: 'page', bannedAt: null, undeliveredGroupPostCount: 0 });
    const where = await service.notificationWhere('viewer');
    expect(where.kind).toEqual({ notIn: expect.arrayContaining(['message', 'community_group_post', 'checkin_reminder']) });
    expect(where.NOT).toEqual({ AND: [{ actorUserId: { not: null } }, { actorUserId: { in: ['blocked', 'muted'] } }] });
  });

  it('aggregates each authorized identity once and filters banned pages', async () => {
    const { prisma, service } = fixture();
    await expect(service.appIconCount('viewer')).resolves.toBe(30);
    expect(prisma.userPageOperator.findMany).toHaveBeenCalledWith({ where: { operatorUserId: 'viewer', page: { bannedAt: null } }, select: { pageUserId: true } });
    expect(prisma.notification.count).toHaveBeenCalledTimes(4);
  });
});
