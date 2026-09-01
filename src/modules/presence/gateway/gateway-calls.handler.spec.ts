import { CallsGatewayHandler } from './gateway-calls.handler';

function makeHandler(userBySocket: Record<string, string | null>) {
  const presence = {
    getUserIdForSocket: jest.fn((id: string) => userBySocket[id] ?? null),
  };
  const call = {
    id: 'call-1',
    conversationId: 'conv-1',
    type: 'video',
    status: 'active',
    startedByUserId: 'u1',
    startedByAdmin: false,
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: null,
    capacity: 2,
    messageId: 'm1',
    participants: [],
  };
  const calls = {
    start: jest.fn(async () => ({ call, iceServers: [] })),
    join: jest.fn(async () => ({ call, iceServers: [] })),
    leave: jest.fn(async () => ({ call: null })),
    decline: jest.fn(async () => ({ call: null })),
    updateParticipantState: jest.fn(async () => undefined),
    relaySignal: jest.fn(async () => undefined),
    markParticipantReconnecting: jest.fn(async () => undefined),
  };
  const handler = new CallsGatewayHandler(presence as any, calls as any);
  return { handler, calls };
}

const socket = (id: string) => ({ id }) as any;

describe('CallsGatewayHandler', () => {
  it('acks not_authenticated for anonymous sockets and never touches the service', async () => {
    const { handler, calls } = makeHandler({ anon: null });
    const ack = await handler.handleCallsStart(socket('anon'), { conversationId: 'conv-1', type: 'video' });
    expect(ack.error?.code).toBe('not_authenticated');
    expect(calls.start).not.toHaveBeenCalled();
  });

  it('rejects malformed start payloads before hitting the service', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    const ack = await handler.handleCallsStart(socket('s1'), { conversationId: 'conv-1', type: 'hologram' });
    expect(ack.error?.code).toBe('invalid_payload');
    expect(calls.start).not.toHaveBeenCalled();
  });

  it('binds the socket on a successful start/join and passes the socket id through', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    const ack = await handler.handleCallsStart(socket('s1'), { conversationId: 'conv-1', type: 'video' });
    expect(ack.call?.id).toBe('call-1');
    expect(calls.start).toHaveBeenCalledWith({ userId: 'u1', socketId: 's1', conversationId: 'conv-1', type: 'video' });
    expect(handler.isSocketBound('s1')).toBe(true);
  });

  it('does not bind on an error ack', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    calls.join.mockResolvedValueOnce({ call: null, error: { code: 'call_full', message: 'full' } } as any);
    const ack = await handler.handleCallsJoin(socket('s1'), { callId: 'call-1' });
    expect(ack.error?.code).toBe('call_full');
    expect(handler.isSocketBound('s1')).toBe(false);
  });

  it('drops rtc:signal and calls:state from sockets that have not joined the call', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    await handler.handleRtcSignal(socket('s1'), { callId: 'call-1', toUserId: 'u2', description: { type: 'offer' } });
    await handler.handleCallsState(socket('s1'), { callId: 'call-1', micEnabled: false });
    expect(calls.relaySignal).not.toHaveBeenCalled();
    expect(calls.updateParticipantState).not.toHaveBeenCalled();

    await handler.handleCallsJoin(socket('s1'), { callId: 'call-1' });
    await handler.handleRtcSignal(socket('s1'), { callId: 'call-1', toUserId: 'u2', description: { type: 'offer' } });
    await handler.handleCallsState(socket('s1'), { callId: 'call-1', micEnabled: false });
    expect(calls.relaySignal).toHaveBeenCalledWith({
      fromUserId: 'u1',
      callId: 'call-1',
      toUserId: 'u2',
      description: { type: 'offer' },
      candidate: undefined,
    });
    expect(calls.updateParticipantState).toHaveBeenCalledWith({ userId: 'u1', callId: 'call-1', micEnabled: false });
  });

  it('leave unbinds the socket so a later disconnect does not schedule grace', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    await handler.handleCallsJoin(socket('s1'), { callId: 'call-1' });
    await handler.handleCallsLeave(socket('s1'), { callId: 'call-1' });
    expect(calls.leave).toHaveBeenCalledWith({ userId: 'u1', callId: 'call-1' });
    handler.handleDisconnect(socket('s1'));
    expect(calls.markParticipantReconnecting).not.toHaveBeenCalled();
  });

  it('disconnect of a bound socket marks the participant reconnecting', async () => {
    const { handler, calls } = makeHandler({ s1: 'u1' });
    await handler.handleCallsJoin(socket('s1'), { callId: 'call-1' });
    handler.handleDisconnect(socket('s1'));
    expect(calls.markParticipantReconnecting).toHaveBeenCalledWith({ userId: 'u1', callId: 'call-1', socketId: 's1' });
    expect(handler.isSocketBound('s1')).toBe(false);
  });
});
