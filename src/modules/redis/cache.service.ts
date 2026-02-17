import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class CacheService {
  constructor(private readonly redis: RedisService) {}

  async getJson<T>(key: string): Promise<T | null> {
    return await this.redis.getJson<T>(key);
  }

  async setJson(key: string, value: unknown, opts: { ttlSeconds?: number; ttlMs?: number }): Promise<void> {
    await this.redis.setJson(key, value, opts);
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

    const cached = await this.redis.getJson<T>(key);
    if (cached !== null) return cached;

    const value = await params.compute();
    void this.redis.setJson(key, value, { ttlSeconds: Math.max(1, Math.floor(params.ttlSeconds || 1)) }).catch(() => undefined);
    return value;
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
  }): Promise<T> {
    const key = (params.key ?? '').trim();
    const lockKey = (params.lockKey ?? '').trim();
    if (!params.enabled || !key || !lockKey) return await params.computeAndSet();

    const cached = await this.redis.getJson<T>(key);
    if (cached !== null) return cached;

    const locked = await this.redis.withLock(
      lockKey,
      { ttlMs: Math.max(1, Math.floor(params.lockTtlMs)), waitMs: Math.max(0, Math.floor(params.lockWaitMs)), retryDelayMs: 25 },
      async () => {
        const cachedInside = await this.redis.getJson<T>(key);
        if (cachedInside !== null) return cachedInside;
        const v = await params.computeAndSet();
        await this.redis.setJson(key, v, { ttlSeconds: Math.max(1, Math.floor(params.ttlSeconds || 1)) });
        return v;
      },
    );
    if (locked !== null) return locked;
    return await params.fallback();
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

