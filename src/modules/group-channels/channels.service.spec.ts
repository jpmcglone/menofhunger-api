import { ChannelsService } from './channels.service';

function harness(role = 'owner') {
  const channel = { id: 'c1', name: 'omg', defaultPurpose: null, privacy: 'normal', archivedAt: null, conversationId: 'conv' };
  const tx: any = { groupChannel: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) } };
  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const access: any = { lockGroup: jest.fn(), channel: jest.fn().mockResolvedValue({ channel, member: { role } }), recipients: jest.fn().mockResolvedValue([]), member: jest.fn().mockResolvedValue({ role }) };
  const realtime: any = { emitGroupChannelChanged: jest.fn() };
  const service = new ChannelsService(prisma, access, realtime, { dispatch: jest.fn() } as any);
  jest.spyOn(service, 'list').mockResolvedValue([{ id: 'c1', icon: '🔥' } as any]);
  return { service, tx };
}

describe('channel custom icon', () => {
  it('lets a leader set, change and clear the icon', async () => {
    const h = harness();
    await h.service.update('leader', 'group', 'c1', { icon: ' 🔥 ' });
    expect(h.tx.groupChannel.update.mock.calls[0][0].data).toMatchObject({ icon: '🔥' });
    await h.service.update('leader', 'group', 'c1', { icon: null });
    expect(h.tx.groupChannel.update.mock.calls[1][0].data).toMatchObject({ icon: null });
  });
  it('leaves the icon untouched when the patch does not mention it', async () => {
    const h = harness();
    await h.service.update('leader', 'group', 'c1', { topic: 'New topic' });
    expect(h.tx.groupChannel.update.mock.calls[0][0].data).not.toHaveProperty('icon');
  });
  it('refuses members and invalid icons before writing', async () => {
    await expect(harness('member').service.update('member', 'group', 'c1', { icon: '🔥' })).rejects.toThrow('Only group leaders');
    const h = harness();
    await expect(h.service.update('leader', 'group', 'c1', { icon: 'abc' })).rejects.toThrow('single emoji');
    expect(h.tx.groupChannel.update).not.toHaveBeenCalled();
  });
  it('stores the icon on creation', async () => {
    const h = harness();
    h.tx.groupChannel.create = jest.fn().mockResolvedValue({ id: 'c1' });
    await h.service.create('leader', 'group', { name: 'omg', icon: '🔥', privacy: 'normal' });
    expect(h.tx.groupChannel.create.mock.calls[0][0].data).toMatchObject({ icon: '🔥' });
  });
});
