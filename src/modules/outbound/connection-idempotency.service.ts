import { ConflictException, Injectable, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { RedisService } from '../redis/redis.service';

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
/** Only non-secret first-party connection results may use this cache. OAuth is separate. */
@Injectable()
export class ConnectionIdempotencyService {
  constructor(private readonly redis: RedisService) {}
  async run<T>(account: string, path: string, key: string | undefined, body: unknown, action: () => Promise<T>): Promise<T> {
    if (!key) return action();
    if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new BadRequestException('Invalid Idempotency-Key.');
    const digest = (v: string) => createHash('sha256').update(v).digest('hex');
    const cacheKey = `connection:idempotency:${digest(JSON.stringify([account, path, key]))}`;
    const fingerprint = digest(JSON.stringify(stable(body)));
    const cached = await this.redis.getString(cacheKey);
    if (cached) {
      const prior = JSON.parse(cached);
      if (prior.fingerprint !== fingerprint) throw new ConflictException('This key was used with a different request.');
      return prior.result as T;
    }
    const lockKey = `${cacheKey}:lock`, lock = randomBytes(20).toString('hex');
    if (!await this.redis.setString(lockKey, lock, { onlyIfAbsent: true, ttlSeconds: 120 })) throw new ConflictException('This request is still in progress. Retry with the same key.');
    try {
      const raced = await this.redis.getString(cacheKey);
      if (raced) {
        const prior = JSON.parse(raced);
        if (prior.fingerprint !== fingerprint) throw new ConflictException('This key was used with a different request.');
        return prior.result as T;
      }
      const result = await action();
      await this.redis.setString(cacheKey, JSON.stringify({ fingerprint, result }), { ttlSeconds: 86400 });
      return result;
    } finally {
      await this.redis.raw().eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lockKey, lock);
    }
  }
}
