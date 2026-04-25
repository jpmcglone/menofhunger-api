import { PresenceRealtimeService } from './presence-realtime.service';

describe('PresenceRealtimeService user statuses', () => {
  function makeService() {
    const emittedBySocket = new Map<string, Array<{ event: string; payload: unknown }>>();
    const server = {
      sockets: {
        sockets: new Map([
          ['subscriber-socket', { emit: jest.fn((event: string, payload: unknown) => emittedBySocket.get('subscriber-socket')!.push({ event, payload })) }],
          ['feed-socket', { emit: jest.fn((event: string, payload: unknown) => emittedBySocket.get('feed-socket')!.push({ event, payload })) }],
          ['own-socket', { emit: jest.fn((event: string, payload: unknown) => emittedBySocket.get('own-socket')!.push({ event, payload })) }],
        ]),
      },
    };
    emittedBySocket.set('subscriber-socket', []);
    emittedBySocket.set('feed-socket', []);
    emittedBySocket.set('own-socket', []);

    const presence = {
      getSubscribers: jest.fn().mockReturnValue(new Set(['subscriber-socket'])),
      getOnlineFeedListeners: jest.fn().mockReturnValue(new Set(['feed-socket'])),
      getSocketIdsForUser: jest.fn().mockReturnValue(['own-socket']),
      emitToUser: jest.fn(),
    };
    const presenceRedis = {
      publishUserStatusChanged: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PresenceRealtimeService(presence as any, presenceRedis as any);
    service.setServer(server as any);
    return { service, emittedBySocket, presenceRedis };
  }

  it('emits status updates to subscribers, online feed listeners, and the user sockets', () => {
    const { service, emittedBySocket, presenceRedis } = makeService();
    const payload = {
      status: {
        userId: 'user-1',
        text: 'Around tonight',
        setAt: '2026-04-25T03:00:00.000Z',
        expiresAt: '2026-04-26T03:00:00.000Z',
      },
    };

    service.emitPresenceStatusUpdated('user-1', payload);

    expect(emittedBySocket.get('subscriber-socket')).toEqual([{ event: 'presence:status-updated', payload }]);
    expect(emittedBySocket.get('feed-socket')).toEqual([{ event: 'presence:status-updated', payload }]);
    expect(emittedBySocket.get('own-socket')).toEqual([{ event: 'presence:status-updated', payload }]);
    expect(presenceRedis.publishUserStatusChanged).toHaveBeenCalledWith({
      userId: 'user-1',
      event: 'presence:status-updated',
      payload,
    });
  });

  it('emits status clears through the same fanout path', () => {
    const { service, emittedBySocket, presenceRedis } = makeService();
    const payload = { userId: 'user-1' };

    service.emitPresenceStatusCleared('user-1', payload);

    expect(emittedBySocket.get('subscriber-socket')).toEqual([{ event: 'presence:status-cleared', payload }]);
    expect(emittedBySocket.get('feed-socket')).toEqual([{ event: 'presence:status-cleared', payload }]);
    expect(emittedBySocket.get('own-socket')).toEqual([{ event: 'presence:status-cleared', payload }]);
    expect(presenceRedis.publishUserStatusChanged).toHaveBeenCalledWith({
      userId: 'user-1',
      event: 'presence:status-cleared',
      payload,
    });
  });
});
