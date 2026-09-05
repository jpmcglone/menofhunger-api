import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class CacheService {
  constructor(private readonly redis: RedisService) {}

  private readonly pending = new Map<string, Promise<unknown>>();

  private async share<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = compute();
    this.pending.set(key, promise);
    try { return await promise; }
    finally { if (this.pending.get(key) === promise) this.pending.delete(key); }
  }

  async getJson<T>(key: string): Promise<T | null> {
    return await this.redis.getJson<T>(key);
  }

  async setJson(key: string, value: unknown, opts: { ttlSeconds?: number; ttlMs?: number }): Promise<void> {
    await this.redis.setJson(key, value, opts);
  }

  async del(...keys: string[]): Promise<void> {
    await this.redis.del(...keys);
  }

  /**
   * Acquire a distributed Redis lock and run `fn` while holding it.
   * Returns the result of `fn` on success, or `null` if the lock couldn't be
   * acquired within `waitMs`. Delegates to `RedisService.withLock`.
   */
  async withLock<T>(
    lockKey: string,
    opts: { ttlMs: number; waitMs: number; retryDelayMs?: number },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    return this.redis.withLock(lockKey, opts, fn);
  }

  /**
   * Read-through cache for JSON values.
   * If `enabled` is false, it bypasses cache but still computes the value.
   */
  async getOrSetJson<T>(params: {
    enabled: boolean;
    key: string;
    ttlSeconds: number;
    compute: () => Promise<T>;
  }): Promise<T> {
    const key = (params.key ?? '').trim();
    if (!params.enabled || !key) return await params.compute();

    return this.share(`json:${key}`, async () => {
      const cached = await this.redis.getJson<T>(key).catch(() => null);
      if (cached !== null) return cached;
      const value = await params.compute();
      await this.redis.setJson(key, value, { ttlSeconds: Math.max(1, params.ttlSeconds) }).catch(() => undefined);
      return value;
    });
  }

  /**
   * Read-through cache with a distributed lock to prevent stampedes.
   * If lock acquisition fails quickly, returns `fallback()` (usually stale DB value).
   */
  async getOrSetJsonWithLock<T>(params: {
    enabled: boolean;
    key: string;
    ttlSeconds: number;
    lockKey: string;
    lockTtlMs: number;
    lockWaitMs: number;
    computeAndSet: () => Promise<T>;
    fallback: () => Promise<T>;
    /** On contention, await the lock owner's result instead of running fallback. */
    waitForResult?: boolean;
  }): Promise<T> {
    const key = (params.key ?? '').trim();
    const lockKey = (params.lockKey ?? '').trim();
    if (!params.enabled || !key || !lockKey) return await params.computeAndSet();

    return this.share(`locked:${key}`, async () => {
      try {
        const cached = await this.redis.getJson<T>(key);
        if (cached !== null) return cached;
      } catch {
        // Redis unavailable: still collapse requests on this API instance.
        return params.computeAndSet();
      }

      let started = false;
      let locked: T | null;
      try {
        locked = await this.redis.withLock(
          lockKey,
          { ttlMs: Math.max(1, params.lockTtlMs), waitMs: Math.max(0, params.lockWaitMs), retryDelayMs: 25 },
          async () => {
            const cachedInside = await this.redis.getJson<T>(key);
            if (cachedInside !== null) return cachedInside;
            started = true;
            const value = await params.computeAndSet();
            await this.redis.setJson(key, value, { ttlSeconds: Math.max(1, params.ttlSeconds) }).catch(() => undefined);
            return value;
          },
        );
      } catch (error) {
        if (started) throw error;
        return params.computeAndSet();
      }
      if (locked !== null) return locked;
      if (!params.waitForResult) return params.fallback();

      // Do not multiply expensive database work while another instance owns it.
      const deadline = Date.now() + Math.max(0, params.lockTtlMs - params.lockWaitMs);
      do {
        const result = await this.redis.getJson<T>(key);
        if (result !== null) return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new ServiceUnavailableException('Feed is still being prepared. Please retry.');
    });
  }

  /**
   * Read-through cache that supports caching nulls distinctly.
   * Useful for external services where "no result" is common and should not stampede.
   */
  async getOrSetNullableJson<T>(params: {
    enabled: boolean;
    key: string;
    ttlSeconds: number;
    nullTtlSeconds: number;
    compute: () => Promise<T | null>;
  }): Promise<T | null> {
    const key = (params.key ?? '').trim();
    if (!params.enabled || !key) return await params.compute();

    const cached = await this.redis.getJson<{ meta: T | null }>(key);
    if (cached && Object.prototype.hasOwnProperty.call(cached, 'meta')) return cached.meta ?? null;

    const value = await params.compute();
    const ttlSeconds = value == null ? params.nullTtlSeconds : params.ttlSeconds;
    void this.redis.setJson(key, { meta: value }, { ttlSeconds: Math.max(1, Math.floor(ttlSeconds || 1)) }).catch(() => undefined);
    return value;
  }
}

