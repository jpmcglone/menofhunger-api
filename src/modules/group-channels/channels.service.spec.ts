import { ChannelsService } from './channels.service';

function harness(role = 'owner') {
  const channel = { id: 'c1', name: 'omg', defaultPurpose: null, privacy: 'normal', archivedAt: null, conversationId: 'conv' };
  const tx: any = { groupChannel: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) } };
  const prisma: any = { communityGroupMember: { findMany: jest.fn().mockResolvedValue([]) }, $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const access: any = { lockGroup: jest.fn(), channel: jest.fn().mockResolvedValue({ channel, member: { role } }), recipients: jest.fn().mockResolvedValue([]), member: jest.fn().mockResolvedValue({ role }) };
  const realtime: any = { emitGroupChannelChanged: jest.fn() };
  const service = new ChannelsService(prisma, access, realtime, { dispatch: jest.fn() } as any, { r2: () => ({ publicBaseUrl: "https://assets.example" }) } as any);
  jest.spyOn(service, 'list').mockResolvedValue([{ id: 'c1', icon: '🔥' } as any]);
  return { service, tx, prisma };
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


describe('channel mention member profiles', () => {
  it('returns canonical avatar and tier fields, while private-channel membership is query-filtered', async () => {
    const h = harness();
    h.prisma.communityGroupMember.findMany.mockResolvedValue([{ role: 'member', user: { id: 'thomas', username: 'Thomas', name: 'Thomas', premium: true, premiumPlus: false, verifiedStatus: 'manual', isOrganization: false, avatarKey: 'avatars/thomas.png', avatarUpdatedAt: null } }]);
    const members = await h.service.members('viewer', 'group', 'c1', 'thom');
    expect(members[0]).toMatchObject({ role: 'member', user: { username: 'Thomas', avatarUrl: 'https://assets.example/avatars/thomas.png', premium: true, verifiedStatus: 'manual', isOrganization: false } });
    expect(members[0].user).not.toHaveProperty('avatarKey');
    expect(h.prisma.communityGroupMember.findMany.mock.calls[0][0].where.groupId).toBe('group');
  });
  it('invalidates referencing messages for the whole active group after a channel rename', async () => {
    const h = harness(); h.prisma.communityGroupMember.findMany.mockResolvedValue([{ userId: 'outside-private-channel' }]);
    const realtime = (h.service as any).realtime;
    await h.service.update('leader', 'group', 'c1', { name: 'renamed' });
    expect(realtime.emitGroupChannelChanged).toHaveBeenCalledWith('outside-private-channel', { groupId: 'group', channelId: 'c1', reason: 'channel' });
    expect(JSON.stringify(realtime.emitGroupChannelChanged.mock.calls)).not.toContain('renamed');
  });
});
