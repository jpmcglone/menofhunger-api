import { PresenceRedisStateService } from './presence-redis-state.service';

function makeService(overrides?: { lastConnectAtMsByUserId?: (ids: string[]) => Promise<Map<string, number | null>> }) {
  const redis = {
    duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
    raw: jest.fn(() => ({ pipeline: jest.fn(() => ({ zscore: jest.fn(), exec: jest.fn(async () => []) })) })),
    setJson: jest.fn(),
    del: jest.fn(),
  } as any;
  const appConfig = { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any;
  const presence = { persistLastOnlineAt: jest.fn() } as any;
  const svc = new PresenceRedisStateService(redis, appConfig, presence);
  if (overrides?.lastConnectAtMsByUserId) {
    (svc as any).lastConnectAtMsByUserId = overrides.lastConnectAtMsByUserId;
  }
  return { svc, presence };
}

describe('PresenceRedisStateService.onlineByUserIds', () => {
  it('marks users online when lastConnectAt exists', async () => {
    const { svc } = makeService({
      lastConnectAtMsByUserId: async (ids) => {
        const m = new Map<string, number | null>();
        for (const id of ids) m.set(id, id === 'u1' ? 123 : null);
        return m;
      },
    });

    const res = await svc.onlineByUserIds(['u1', 'u2']);
    expect(res.get('u1')).toBe(true);
    expect(res.get('u2')).toBe(false);
  });
});

describe('PresenceRedisStateService.platformsByUserIds', () => {
  it('aggregates and deduplicates platforms across API instances', async () => {
    const membersPipeline = {
      smembers: jest.fn(),
      exec: jest.fn(async () => [
        [null, ['instance-a:socket-web', 'instance-b:socket-ios', 'instance-a:socket-web-2']],
      ]),
    };
    const socketsPipeline = {
      get: jest.fn(),
      exec: jest.fn(async () => [
        [null, JSON.stringify({ client: 'web', connectedAtMs: 100 })],
        [null, JSON.stringify({ client: 'ios', connectedAtMs: 300 })],
        [null, JSON.stringify({ client: 'web', connectedAtMs: 200 })],
      ]),
    };
    const rawRedis = {
      pipeline: jest.fn()
        .mockReturnValueOnce(membersPipeline)
        .mockReturnValueOnce(socketsPipeline),
    };
    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => rawRedis),
    } as any;
    const appConfig = { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any;
    const presence = { getClientsForUser: jest.fn(() => ['web']) } as any;
    const service = new PresenceRedisStateService(redis, appConfig, presence);

    const platforms = await service.platformsByUserIds(['user-1']);

    expect(platforms.get('user-1')).toEqual(['ios', 'web']);
  });
});

describe('PresenceRedisStateService.touchSocket', () => {
  it('preserves connectedAtMs while refreshing socket metadata', async () => {
    const rawRedis = { expire: jest.fn(async () => 1) };
    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => rawRedis),
      getJson: jest.fn(async () => ({ connectedAtMs: 123 })),
      setJson: jest.fn(async () => undefined),
    } as any;
    const service = new PresenceRedisStateService(
      redis,
      { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any,
      {} as any,
    );

    await service.touchSocket({ socketId: 'socket-1', userId: 'user-1', client: 'ios' });

    expect(redis.setJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        userId: 'user-1',
        client: 'ios',
        connectedAtMs: 123,
        lastSeenAtMs: expect.any(Number),
      }),
      { ttlSeconds: 660 },
    );
  });
});

describe('PresenceRedisStateService.sweepOfflineUsers', () => {
  it('calls persistLastOnlineAt for each user pruned from the online zset', async () => {
    const staleUserId = 'user-stale';
    const liveUserId = 'user-live';

    const rawRedis = {
      zrange: jest.fn(async () => [staleUserId, liveUserId]),
      // staleUserId has 0 sockets; liveUserId has 1
      scard: jest.fn(async (key: string) => (key.includes(liveUserId) ? 1 : 0)),
      zrem: jest.fn(async () => 1),
      srem: jest.fn(async () => 0),
      // For the publish call
      publish: jest.fn(async () => 0),
    };

    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => rawRedis),
      setJson: jest.fn(),
      del: jest.fn(),
    } as any;

    const appConfig = { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any;
    const presence = { persistLastOnlineAt: jest.fn() } as any;
    const svc = new PresenceRedisStateService(redis, appConfig, presence);

    await svc.sweepOfflineUsers();

    // Only the stale user should have lastOnlineAt persisted.
    expect(presence.persistLastOnlineAt).toHaveBeenCalledWith(staleUserId);
    expect(presence.persistLastOnlineAt).not.toHaveBeenCalledWith(liveUserId);
  });
});

describe('PresenceRedisStateService.isUserActivelyOnIos', () => {
  it('returns false when idle', async () => {
    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => ({ sismember: jest.fn(async () => 1) })),
    } as any;
    const service = new PresenceRedisStateService(redis, { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any, {} as any);
    await expect(service.isUserActivelyOnIos('u1')).resolves.toBe(false);
  });

  it('returns true when non-idle and platforms include ios', async () => {
    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => ({ sismember: jest.fn(async () => 0) })),
    } as any;
    const service = new PresenceRedisStateService(redis, { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any, {} as any);
    jest.spyOn(service, 'platformsByUserIds').mockResolvedValue(new Map([['u1', ['web', 'ios']]]));
    await expect(service.isUserActivelyOnIos('u1')).resolves.toBe(true);
  });

  it('returns false when only web is present', async () => {
    const redis = {
      duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
      raw: jest.fn(() => ({ sismember: jest.fn(async () => 0) })),
    } as any;
    const service = new PresenceRedisStateService(redis, { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any, {} as any);
    jest.spyOn(service, 'platformsByUserIds').mockResolvedValue(new Map([['u1', ['web']]]));
    await expect(service.isUserActivelyOnIos('u1')).resolves.toBe(false);
  });
});

