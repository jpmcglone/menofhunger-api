import { ConnectionIdempotencyService } from './connection-idempotency.service';

describe('connection idempotency', () => {
  function harness() {
    const entries = new Map<string, string>();
    const setString = jest.fn(async (key: string, value: string, options: any) => {
      if (options.onlyIfAbsent && entries.has(key)) return false;
      entries.set(key, value); return true;
    });
    const redis: any = { getString: async (key: string) => entries.get(key), setString,
      raw: () => ({ eval: async (_script: string, _count: number, key: string, owner: string) => {
        if (entries.get(key) === owner) entries.delete(key);
      } }) };
    return { service: new ConnectionIdempotencyService(redis), entries, setString };
  }
  it('replays the original result for 24 hours without caching request credentials', async () => {
    const h = harness(); const action = jest.fn(async () => ({ connected: true }));
    await h.service.run('account', '/connect', 'key', { username: 'member', clientSecret: 'sensitive' }, action);
    expect(await h.service.run('account', '/connect', 'key', { clientSecret: 'sensitive', username: 'member' }, action)).toEqual({ connected: true });
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.setString).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('fingerprint'), { ttlSeconds: 86400 });
    expect([...h.entries.values()].join('')).not.toContain('sensitive');
  });
  it('rejects a conflicting payload and isolates account identities', async () => {
    const h = harness(); const action = jest.fn(async () => ({ connected: true }));
    await h.service.run('account', '/connect', 'key', { username: 'first' }, action);
    await expect(h.service.run('account', '/connect', 'key', { username: 'second' }, action)).rejects.toMatchObject({ status: 409 });
    await h.service.run('page', '/connect', 'key', { username: 'second' }, action);
    expect(action).toHaveBeenCalledTimes(2);
  });
  it('prevents two workers from executing an in-flight mutation', async () => {
    const h = harness(); let finish!: () => void;
    const action = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = h.service.run('account', '/connect', 'key', {}, action);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    await expect(h.service.run('account', '/connect', 'key', {}, action)).rejects.toMatchObject({ status: 409 });
    finish(); await first; expect(action).toHaveBeenCalledTimes(1);
  });
});
