import { ChannelAttentionService } from './channel-attention.service';

function setup() {
  const tx: any = {
    groupChannelAttention: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn() },
    groupChannelThreadState: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn(), updateMany: jest.fn() },
    groupChannelViewerState: { upsert: jest.fn(), updateMany: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    message: { findMany: jest.fn().mockResolvedValue([{ id: 'visible' }]), findFirst: jest.fn() },
  };
  const prisma: any = { $transaction: (fn: any) => fn(tx) };
  const access: any = { lockGroup: jest.fn(), channel: jest.fn().mockResolvedValue({ channel: { conversationId: 'conversation', lastSequence: 20 } }), recipients: jest.fn().mockResolvedValue([{ userId: 'author' }, { userId: 'viewer' }]) };
  const channels: any = { viewerChanged: jest.fn() };
  const effects: any = { dispatch: jest.fn() };
  const presence: any = { onlineUserIds: jest.fn().mockResolvedValue(['viewer']) };
  return { presence, tx, access, channels, effects, service: new ChannelAttentionService(prisma, access, channels, effects, presence) };
}
const message = { groupId: 'group', channelId: 'channel', messageId: 'message', senderId: 'author', body: '@viewer hello', threadRootId: 'root' };

describe('channel personal attention', () => {
  it('stores mention plus followed reply once, excluding the sender', async () => {
    const { tx, service } = setup();
    tx.user.findMany.mockResolvedValue([{ id: 'viewer' }]);
    tx.groupChannelThreadState.findMany.mockResolvedValue([{ userId: 'viewer' }]);
    await service.reconcile(tx, message);
    expect(tx.groupChannelAttention.upsert).toHaveBeenCalledTimes(1);
    expect(tx.groupChannelAttention.upsert.mock.calls[0][0].create).toMatchObject({ userId: 'viewer', mentioned: true, followedReply: true });
    expect(tx.user.findMany.mock.calls[0][0].where.id.in).toEqual(['viewer']);
  });
  it('preserves read state for unchanged mentions but reopens a newly added mention', async () => {
    const { tx, service } = setup();
    tx.user.findMany.mockResolvedValue([{ id: 'viewer' }]);
    tx.groupChannelAttention.findMany.mockResolvedValue([{ userId: 'viewer', mentioned: true }]);
    await service.reconcile(tx, { ...message, edited: true });
    expect(tx.groupChannelAttention.upsert.mock.calls[0][0].update).not.toHaveProperty('readAt');
    tx.groupChannelAttention.findMany.mockResolvedValue([{ userId: 'viewer', mentioned: false }]);
    await service.reconcile(tx, { ...message, edited: true });
    expect(tx.groupChannelAttention.upsert.mock.calls[1][0].update.readAt).toBeNull();
    expect(tx.groupChannelAttention.upsert.mock.calls[1][0].update).not.toHaveProperty('followedReply');
  });
  it('removes the mention reason while retaining independent followed replies', async () => {
    const { tx, service } = setup();
    await service.reconcile(tx, { ...message, body: 'hello', edited: true });
    expect(tx.groupChannelAttention.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { mentioned: false } }));
    expect(tx.groupChannelAttention.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'message', mentioned: false, followedReply: false } });
    expect(tx.groupChannelAttention.upsert).not.toHaveBeenCalled();
  });
  it('acknowledges only accessible viewed IDs without clearing unrelated personal attention', async () => {
    const { tx, service, channels } = setup();
    await service.acknowledge('viewer', 'group', 'channel', { messageIds: ['visible', 'other-channel'] });
    expect(tx.groupChannelAttention.updateMany.mock.calls[0][0].where.messageId.in).toEqual(['visible']);
    expect(tx.groupChannelViewerState.upsert).not.toHaveBeenCalled();
    expect(channels.viewerChanged).toHaveBeenCalledWith('viewer', 'group', 'channel', expect.objectContaining({ readMessageIds: ['visible'] }));
  });
  it('mark unread restores thread position without creating attention or push jobs', async () => {
    const { tx, service, effects } = setup();
    tx.message.findFirst.mockResolvedValue({ channelSequence: 8, threadRootId: 'root' });
    await service.markUnread('viewer', 'group', 'channel', 'reply');
    expect(tx.groupChannelThreadState.updateMany).toHaveBeenCalledWith({ where: { rootMessageId: 'root', userId: 'viewer' }, data: { readThrough: 7 } });
    expect(tx.groupChannelAttention.upsert).not.toHaveBeenCalled();
    expect(effects.dispatch).not.toHaveBeenCalled();
  });
  it('@everyone reaches every eligible member and @here only those online, for leaders only', async () => {
    const { tx, access, presence, service } = setup();
    access.recipients.mockResolvedValue([{ userId: 'viewer' }, { userId: 'away' }, { userId: 'author' }]);
    await service.reconcile(tx, { ...message, body: '@everyone standup', broadcast: true });
    expect(tx.groupChannelAttention.upsert.mock.calls.map((call: any) => call[0].create.userId).sort()).toEqual(['away', 'viewer']);
    tx.groupChannelAttention.upsert.mockClear();
    await service.reconcile(tx, { ...message, body: '@here standup', broadcast: true });
    expect(presence.onlineUserIds).toHaveBeenCalled();
    expect(tx.groupChannelAttention.upsert.mock.calls.map((call: any) => call[0].create.userId)).toEqual(['viewer']);
    tx.groupChannelAttention.upsert.mockClear();
    await service.reconcile(tx, { ...message, body: '@everyone standup' });
    expect(tx.groupChannelAttention.upsert).not.toHaveBeenCalled();
  });
});
