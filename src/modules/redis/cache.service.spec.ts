import { CacheService } from './cache.service';

function setup() {
  const values = new Map<string, unknown>();
  const redis = {
    getJson: jest.fn(async (key: string) => values.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    withLock: jest.fn(async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn()),
  };
  const service = new CacheService(redis as any);
  return { service, redis, values };
}
const options = (compute: () => Promise<unknown>) => ({
  enabled: true, key: 'viewer:feed', lockKey: 'lock:viewer:feed', ttlSeconds: 15,
  lockTtlMs: 200, lockWaitMs: 10, computeAndSet: compute, fallback: compute, waitForResult: true,
});

describe('cache work sharing', () => {
  it('runs only one computation for 100 concurrent requests', async () => {
    const { service } = setup();
    const compute = jest.fn(async () => ({ ids: ['post'] }));
    const results = await Promise.all(Array.from({ length: 100 }, () => service.getOrSetJsonWithLock(options(compute))));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(results.every((r: any) => r.ids[0] === 'post')).toBe(true);
  });

  it('waits for the other instance instead of duplicating its computation', async () => {
    const { service, redis, values } = setup();
    redis.withLock.mockImplementation(async () => null);
    const compute = jest.fn(async () => ({ ids: ['duplicate'] }));
    const pending = service.getOrSetJsonWithLock(options(compute));
    const timer = setTimeout(() => values.set('viewer:feed', { ids: ['owner-result'] }), 20);
    try { expect(await pending).toEqual({ ids: ['owner-result'] }); }
    finally { clearTimeout(timer); }
    expect(compute).not.toHaveBeenCalled();
  });

  it('returns a retryable error if the owner fails, without a second expensive query', async () => {
    const { service, redis } = setup();
    redis.withLock.mockImplementation(async () => null);
    const compute = jest.fn(async () => ({}));
    await expect(service.getOrSetJsonWithLock({ ...options(compute), lockTtlMs: 10 })).rejects.toThrow('Please retry');
    expect(compute).not.toHaveBeenCalled();
  });

  it('shares database fallback while Redis is unavailable and releases failed work', async () => {
    const { service, redis } = setup();
    redis.getJson.mockRejectedValue(new Error('Redis unavailable'));
    const compute = jest.fn().mockRejectedValueOnce(new Error('Database unavailable')).mockResolvedValue({ ok: true });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => service.getOrSetJsonWithLock(options(compute))));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await service.getOrSetJsonWithLock(options(compute))).toEqual({ ok: true });
  });

  it('keeps different viewers isolated', async () => {
    const { service } = setup();
    const a = options(async () => 'a');
    const b = { ...options(async () => 'b'), key: 'other:feed', lockKey: 'other:lock' };
    expect(await Promise.all([service.getOrSetJsonWithLock(a), service.getOrSetJsonWithLock(b)])).toEqual(['a', 'b']);
  });
});
