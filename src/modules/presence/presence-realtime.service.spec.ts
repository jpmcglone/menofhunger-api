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
        postId: null,
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

describe('PresenceRealtimeService.emitGroupNewPost', () => {
  function makeRoomService() {
    const roomEmit = jest.fn();
    const server = { to: jest.fn().mockReturnValue({ emit: roomEmit }) };
    const presence = {} as any;
    const presenceRedis = { publishEmitToRoom: jest.fn().mockResolvedValue(undefined) };
    const service = new PresenceRealtimeService(presence, presenceRedis as any);
    service.setServer(server as any);
    return { service, server, roomEmit, presenceRedis };
  }

  it('emits groups:newPost to the group room', () => {
    const { service, server, roomEmit, presenceRedis } = makeRoomService();
    const payload = { groupId: 'group-1', post: { id: 'p1' } as any };

    service.emitGroupNewPost('group-1', payload);

    expect(server.to).toHaveBeenCalledWith('group:group-1');
    expect(roomEmit).toHaveBeenCalledWith('groups:newPost', payload);
    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith({
      room: 'group:group-1',
      event: 'groups:newPost',
      payload,
    });
  });

  it('ignores a blank group id', () => {
    const { service, server } = makeRoomService();
    service.emitGroupNewPost('  ', { groupId: '', post: {} as any });
    expect(server.to).not.toHaveBeenCalled();
  });
});

/**
 * Worker processes (`RUN_HTTP=false`) never receive `setServer`, so the Redis publish is the
 * ONLY delivery path for realtime events originating from a background job. These tests pin
 * that contract: no local socket server must never mean "drop the emit".
 */
describe('PresenceRealtimeService without a local socket server', () => {
  function makeServerlessService() {
    const presence = { emitToUser: jest.fn() };
    const presenceRedis = {
      publishEmitToUser: jest.fn().mockResolvedValue(undefined),
      publishEmitToRoom: jest.fn().mockResolvedValue(undefined),
      publishBroadcast: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PresenceRealtimeService(presence as any, presenceRedis as any);
    return { service, presence, presenceRedis };
  }

  it('publishes per-user emits cross-instance even with no server attached', () => {
    const { service, presence, presenceRedis } = makeServerlessService();

    service.emitNotificationsUpdated('user-1', { undeliveredCount: 3 });
    service.emitNotificationsLockScreenClear('user-1', { section: 'inbox' });

    expect(presence.emitToUser).not.toHaveBeenCalled();
    expect(presenceRedis.publishEmitToUser).toHaveBeenCalledWith({
      userId: 'user-1',
      event: 'notifications:updated',
      payload: { undeliveredCount: 3 },
    });
    expect(presenceRedis.publishEmitToUser).toHaveBeenCalledWith({
      userId: 'user-1',
      event: 'notifications:lock-screen-clear',
      payload: { section: 'inbox' },
    });
  });

  it('publishes room emits cross-instance even with no server attached', () => {
    const { service, presenceRedis } = makeServerlessService();
    const payload = { groupId: 'group-1', post: { id: 'p1' } as any };

    service.emitGroupNewPost('group-1', payload);

    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith({
      room: 'group:group-1',
      event: 'groups:newPost',
      payload,
    });
  });

  it('publishes spaces:updated to the lobbies room cross-instance', () => {
    const { service, presenceRedis } = makeServerlessService();
    const payload = {
      spaceId: 'space-1',
      version: '2026-08-12T00:00:00.000Z',
      reason: 'schedule_subscribe',
      patch: { subscriberCount: 2 },
    };

    service.emitSpacesUpdated(payload);

    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith({
      room: 'spaces:lobbies',
      event: 'spaces:updated',
      payload,
    });
  });

  it('publishes global broadcasts cross-instance even with no server attached', () => {
    const { service, presenceRedis } = makeServerlessService();

    service.emitDailyContentPublished('word', '2026-08-03');

    expect(presenceRedis.publishBroadcast).toHaveBeenCalledWith({
      event: 'daily:content-published',
      payload: { item: 'word', dayKey: '2026-08-03' },
    });
  });

  it('still skips emits with a blank user id or event', () => {
    const { service, presenceRedis } = makeServerlessService();

    service.emitNotificationsUpdated('  ', { undeliveredCount: 1 });

    expect(presenceRedis.publishEmitToUser).not.toHaveBeenCalled();
  });
});

describe('PresenceRealtimeService.emitGroupMarvChanged', () => {
  function makeRoomService() {
    const roomEmit = jest.fn();
    const server = { to: jest.fn().mockReturnValue({ emit: roomEmit }) };
    const presence = {} as any;
    const presenceRedis = { publishEmitToRoom: jest.fn().mockResolvedValue(undefined) };
    const service = new PresenceRealtimeService(presence, presenceRedis as any);
    service.setServer(server as any);
    return { service, server, roomEmit, presenceRedis };
  }

  it('emits groups:marv-changed to the group room', () => {
    const { service, server, roomEmit, presenceRedis } = makeRoomService();
    const payload = { groupId: 'group-1', isMember: true };

    service.emitGroupMarvChanged('group-1', payload);

    expect(server.to).toHaveBeenCalledWith('group:group-1');
    expect(roomEmit).toHaveBeenCalledWith('groups:marv-changed', payload);
    expect(presenceRedis.publishEmitToRoom).toHaveBeenCalledWith({
      room: 'group:group-1',
      event: 'groups:marv-changed',
      payload,
    });
  });

  it('ignores a blank group id', () => {
    const { service, server } = makeRoomService();
    service.emitGroupMarvChanged('  ', { groupId: '', isMember: false });
    expect(server.to).not.toHaveBeenCalled();
  });
});
