import { prepareChannelDeparture } from './channel-lifecycle';
import type { Prisma } from '@prisma/client';

function setup(leaders: number) {
  const db = {
    $queryRaw: jest.fn(),
    groupChannel: { findMany: jest.fn().mockResolvedValue([{ id: 'private' }]), update: jest.fn() },
    communityGroupMember: { count: jest.fn().mockResolvedValue(leaders) },
    groupChannelAccess: { deleteMany: jest.fn() },
    groupChannelViewerState: { deleteMany: jest.fn() },
    groupChannelAttention: { deleteMany: jest.fn() },
    groupChannelThreadState: { deleteMany: jest.fn() },
  };
  return { db, tx: db as unknown as Prisma.TransactionClient };
}

describe('channel membership lifecycle', () => {
  it('blocks voluntary departure of the last private leader without erasing grants', async () => {
    const { tx, db } = setup(0);
    await expect(prepareChannelDeparture(tx, 'group', 'leader', { forced: false })).rejects.toThrow('Add another group leader');
    expect(db.groupChannelAccess.deleteMany).not.toHaveBeenCalled();
    expect(db.groupChannel.update).not.toHaveBeenCalled();
  });
  it('allows forced removal, archives the orphan and purges private access and attention', async () => {
    const { tx, db } = setup(0);
    await prepareChannelDeparture(tx, 'group', 'leader', { forced: true });
    expect(db.groupChannel.update).toHaveBeenCalledWith({ where: { id: 'private' }, data: { archivedAt: expect.any(Date), revision: { increment: 1 } } });
    expect(db.groupChannelAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: 'leader', channel: { groupId: 'group' } } });
    expect(db.groupChannelAttention.deleteMany).toHaveBeenCalled();
  });
  it('preserves private grants when a safe demotion leaves another leader', async () => {
    const { tx, db } = setup(1);
    await prepareChannelDeparture(tx, 'group', 'leader', { forced: false, demotion: true });
    expect(db.groupChannel.update).not.toHaveBeenCalled();
    expect(db.groupChannelAccess.deleteMany).not.toHaveBeenCalled();
  });
});
