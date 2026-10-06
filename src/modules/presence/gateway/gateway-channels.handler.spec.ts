import { ChannelsGatewayHandler } from './gateway-channels.handler';
import { GatewayThrottleService } from './gateway-throttle.service';

function setup(readable: string[]) {
  const emit = jest.fn();
  const joined = new Set<string>();
  const client: any = {
    id: 's1', data: { spaceChatUser: { id: 'u1', username: 'ann', verifiedStatus: 'manual', premium: false, premiumPlus: false, isOrganization: false } },
    join: (room: string) => joined.add(room), leave: (room: string) => joined.delete(room),
    to: jest.fn(() => ({ emit })),
  };
  const handler = new ChannelsGatewayHandler(
    { getUserIdForSocket: () => 'u1' } as any,
    { publishEmitToRoom: jest.fn().mockResolvedValue(undefined) } as any,
    { member: jest.fn().mockResolvedValue({}), readableWhere: () => ({}) } as any,
    { groupChannel: { findMany: jest.fn().mockResolvedValue(readable.map(id => ({ id }))) } } as any,
    new GatewayThrottleService(),
  );
  return { handler, client, emit, joined };
}

describe('ChannelsGatewayHandler', () => {
  it('relays typing only for channels the socket subscribed to', async () => {
    const { handler, client, emit, joined } = setup(['c1']);
    handler.handleTyping(client, { channelId: 'c1', typing: true });
    expect(emit).not.toHaveBeenCalled();
    await handler.handleSubscribe(client, { groupId: 'g1' });
    expect([...joined]).toEqual(['channel:c1']);
    handler.handleTyping(client, { channelId: 'c2', typing: true });
    expect(emit).not.toHaveBeenCalled();
    handler.handleTyping(client, { channelId: 'c1', threadRootId: 't1', typing: true });
    expect(emit).toHaveBeenCalledWith('group-channels:typing', expect.objectContaining({ groupId: 'g1', channelId: 'c1', threadRootId: 't1', typing: true }));
  });

  it('leaves rooms on unsubscribe', async () => {
    const { handler, client, joined } = setup(['c1']);
    await handler.handleSubscribe(client, { groupId: 'g1' });
    handler.handleUnsubscribe(client, { groupId: 'g1' });
    expect(joined.size).toBe(0);
  });
});
