import { NotFoundException } from '@nestjs/common';
import { ChannelNotificationsSideEffectsHandler } from './channel-notifications-side-effects.handler';
import { ChannelViewingService } from './channel-viewing.service';

function setup() {
  const channel = { id: 'channel', conversationId: 'conversation', privacy: 'private', name: 'leadership' };
  const message = { id: 'message', senderId: 'author', body: 'Protected body', channelSequence: 3, threadRootId: null };
  const prisma: any = {
    message: { findFirst: jest.fn().mockResolvedValue(message) },
    groupChannelViewerState: { findUnique: jest.fn().mockResolvedValue({ preference: 'mentions', readThrough: 0 }) },
    groupChannelAttention: { findUnique: jest.fn().mockResolvedValue({ mentioned: true, followedReply: true, readAt: null }) },
    userBlock: { findFirst: jest.fn().mockResolvedValue(null) }, userMute: { findUnique: jest.fn().mockResolvedValue(null) },
    groupChannelDelivery: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    communityGroup: { findUnique: jest.fn().mockResolvedValue({ slug: 'feedback', name: 'Feedback' }) },
  };
  const access: any = { channel: jest.fn().mockResolvedValue({ channel }), recipients: jest.fn().mockResolvedValue([{ userId: 'reader' }]) };
  const push: any = { sendWebPushToRecipient: jest.fn(), trimPushBody: (s: string) => s };
  const cache: any = { getJson: jest.fn().mockResolvedValue(null), setJson: jest.fn(), del: jest.fn(), withLock: jest.fn(async (_k, _o, f) => f()) };
  const preferences: any = { getPreferencesInternal: jest.fn().mockResolvedValue({ pushMention: true, pushMessage: true, pushGroupActivity: true }) };
  const effects: any = { dispatch: jest.fn() };
  const viewing = new ChannelViewingService(access, cache);
  return { service: new ChannelNotificationsSideEffectsHandler(prisma, access, push, preferences, {} as any, effects, cache, viewing, { send: jest.fn() } as any, { isOnline: jest.fn().mockResolvedValue(true) } as any), viewing, prisma, access, push, cache, preferences, message, channel };
}
const event = { groupId: 'group', channelId: 'channel', messageId: 'message', edited: false };

describe('channel notification delivery', () => {
  it('keeps a second pane active when the first closes and expires abandoned panes', async () => {
    const h = setup();
    h.cache.getJson.mockResolvedValue({ first: Date.now() + 30000, second: Date.now() + 30000, expired: Date.now() - 1 });
    await h.viewing.viewing('reader', 'group', 'channel', false, 'first');
    const leases = h.cache.setJson.mock.calls[0][1];
    expect(Object.keys(leases)).toEqual(['second']);
    h.cache.getJson.mockResolvedValue(leases);
    await h.service.messageChanged(event);
    expect(h.push.sendWebPushToRecipient).not.toHaveBeenCalled();
    h.cache.getJson.mockResolvedValue({ second: Date.now() - 1 });
    await h.service.messageChanged(event);
    expect(h.push.sendWebPushToRecipient).toHaveBeenCalledTimes(1);
  });
  it('delivers one generic private push for a message with both personal reasons', async () => {
    const h = setup(); await h.service.messageChanged(event);
    expect(h.push.sendWebPushToRecipient).toHaveBeenCalledTimes(1);
    const payload = h.push.sendWebPushToRecipient.mock.calls[0][1];
    expect(payload).toMatchObject({ title: 'Men of Hunger', body: 'New activity in a private channel.', tag: 'channel-message-personal' });
    expect(JSON.stringify(payload)).not.toContain('Protected body');
    expect(JSON.stringify(payload)).not.toContain('leadership');
    expect(h.prisma.groupChannelDelivery.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { messageId: 'message', userId: 'reader', reason: 'personal' } }));
  });
  it.each(['off', 'read', 'own', 'viewing', 'revoked', 'deleted', 'delivered', 'blocked', 'muted'])('suppresses %s delivery', async state => {
    const h = setup();
    if (state === 'off') h.prisma.groupChannelViewerState.findUnique.mockResolvedValue({ preference: 'off' });
    if (state === 'read') h.prisma.groupChannelAttention.findUnique.mockResolvedValue({ readAt: new Date(), mentioned: true });
    if (state === 'own') h.message.senderId = 'reader';
    if (state === 'viewing') h.cache.getJson.mockResolvedValue(true);
    if (state === 'revoked') h.access.channel.mockRejectedValue(new NotFoundException());
    if (state === 'deleted') h.prisma.message.findFirst.mockResolvedValue(null);
    if (state === 'delivered') h.prisma.groupChannelDelivery.findUnique.mockResolvedValue({ deliveredAt: new Date() });
    if (state === 'blocked') h.prisma.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    if (state === 'muted') h.prisma.userMute.findUnique.mockResolvedValue({ id: 'mute' });
    await h.service.messageChanged(event);
    expect(h.push.sendWebPushToRecipient).not.toHaveBeenCalled();
  });
  it('rechecks access again at the transport boundary after a queued recipient was eligible', async () => {
    const h = setup(); await h.service.messageChanged(event);
    const guard = h.push.sendWebPushToRecipient.mock.calls[0][1].canDeliver;
    h.access.channel.mockRejectedValue(new NotFoundException());
    await expect(guard()).resolves.toBe(false);
  });
  it('All messages enables ordinary pushes but an edit does not rebroadcast to everyone', async () => {
    const h = setup(); h.prisma.groupChannelAttention.findUnique.mockResolvedValue(null);
    h.prisma.groupChannelViewerState.findUnique.mockResolvedValue({ preference: 'all', readThrough: 0 });
    await h.service.messageChanged(event);
    expect(h.push.sendWebPushToRecipient).toHaveBeenCalledTimes(1);
    h.push.sendWebPushToRecipient.mockClear();
    await h.service.messageChanged({ ...event, edited: true });
    expect(h.push.sendWebPushToRecipient).not.toHaveBeenCalled();
  });
});
