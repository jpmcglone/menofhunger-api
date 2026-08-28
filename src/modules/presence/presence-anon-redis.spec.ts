import { PresenceRedisStateService } from './presence-redis-state.service';

type Store = {
  sets: Map<string, Set<string>>;
  zsets: Map<string, Map<string, number>>;
  kv: Map<string, unknown>;
};

function makeAnonRedis() {
  const store: Store = {
    sets: new Map(),
    zsets: new Map(),
    kv: new Map(),
  };

  const raw = {
    sadd: jest.fn(async (key: string, member: string) => {
      const set = store.sets.get(key) ?? new Set<string>();
      const before = set.size;
      set.add(member);
      store.sets.set(key, set);
      return set.size > before ? 1 : 0;
    }),
    srem: jest.fn(async (key: string, ...members: string[]) => {
      const set = store.sets.get(key);
      if (!set) return 0;
      let n = 0;
      for (const member of members) {
        if (set.delete(member)) n += 1;
      }
      return n;
    }),
    scard: jest.fn(async (key: string) => store.sets.get(key)?.size ?? 0),
    smembers: jest.fn(async (key: string) => [...(store.sets.get(key) ?? [])]),
    expire: jest.fn(async () => 1),
    zadd: jest.fn(async (key: string, mode: string, score: number, member: string) => {
      const zset = store.zsets.get(key) ?? new Map<string, number>();
      if (mode === 'NX' && zset.has(member)) return 0;
      zset.set(member, score);
      store.zsets.set(key, zset);
      return 1;
    }),
    zrem: jest.fn(async (key: string, member: string) => {
      const zset = store.zsets.get(key);
      if (!zset?.has(member)) return 0;
      zset.delete(member);
      return 1;
    }),
    zcard: jest.fn(async (key: string) => store.zsets.get(key)?.size ?? 0),
    zrange: jest.fn(async (key: string) => [...(store.zsets.get(key)?.keys() ?? [])]),
    eval: jest.fn(async () => {
      throw new Error('use fallback unregister');
    }),
    publish: jest.fn(async () => 0),
    pipeline: jest.fn(() => ({
      exists: jest.fn(),
      exec: jest.fn(async () => []),
    })),
  };

  const redis = {
    duplicate: jest.fn(() => ({ subscribe: jest.fn(), on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })),
    raw: jest.fn(() => raw),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.kv.set(key, value);
    }),
    getJson: jest.fn(async (key: string) => store.kv.get(key) ?? null),
    del: jest.fn(async (key: string) => {
      store.kv.delete(key);
    }),
  } as any;

  const svc = new PresenceRedisStateService(
    redis,
    { presenceIdleDisconnectMinutes: jest.fn(() => 10) } as any,
    { persistLastOnlineAt: jest.fn(), clearPersistThrottle: jest.fn() } as any,
  );

  return { svc, store, raw };
}

describe('PresenceRedisStateService — anonymous guests', () => {
  const ANON = 'anon_abcdef123456';

  it('counts two sockets with the same anonId as one unique guest', async () => {
    const { svc } = makeAnonRedis();

    const first = await svc.registerAnonSocket({ socketId: 's1', anonId: ANON, client: 'web' });
    const second = await svc.registerAnonSocket({ socketId: 's2', anonId: ANON, client: 'web' });

    expect(first.isNewlyOnline).toBe(true);
    expect(second.isNewlyOnline).toBe(false);
    expect(await svc.anonymousOnlineCount()).toBe(1);
  });

  it('drops the unique guest only after the last socket disconnects', async () => {
    const { svc } = makeAnonRedis();
    await svc.registerAnonSocket({ socketId: 's1', anonId: ANON, client: 'web' });
    await svc.registerAnonSocket({ socketId: 's2', anonId: ANON, client: 'web' });

    const firstOff = await svc.unregisterAnonSocket({ socketId: 's1', anonId: ANON });
    expect(firstOff.isNowOffline).toBe(false);
    expect(await svc.anonymousOnlineCount()).toBe(1);

    const lastOff = await svc.unregisterAnonSocket({ socketId: 's2', anonId: ANON });
    expect(lastOff.isNowOffline).toBe(true);
    expect(await svc.anonymousOnlineCount()).toBe(0);
  });

  it('uses a short TTL so a dead instance cannot leave ghost guests', async () => {
    const { svc, raw } = makeAnonRedis();
    await svc.registerAnonSocket({ socketId: 's1', anonId: ANON, client: 'web' });
    expect(raw.expire).toHaveBeenCalledWith(expect.any(String), 120);
  });

  it('counts distinct anon ids separately', async () => {
    const { svc } = makeAnonRedis();
    await svc.registerAnonSocket({ socketId: 's1', anonId: ANON, client: 'web' });
    await svc.registerAnonSocket({
      socketId: 's2',
      anonId: 'anon_otherguest99',
      client: 'web',
    });
    expect(await svc.anonymousOnlineCount()).toBe(2);
  });
});
