import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class PublicProfileCacheService<T extends { id: string; username: string | null }> {
  // Keep key format stable but namespace it in Redis so it won't collide with BullMQ keys.
  private readonly prefix = 'cache:publicProfile:';

  constructor(private readonly redis: RedisService) {}

  async read(key: string): Promise<T | null> {
    const k = this.prefix + String(key ?? '').trim();
    if (!k) return null;
    const raw = await this.redis.raw().get(k);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as T;
      if (!parsed || typeof (parsed as any).id !== 'string') return null;
      return parsed;
    } catch {
      // Corrupt cache entry; delete best-effort.
      this.redis.raw().del(k).catch(() => undefined);
      return null;
    }
  }

  async write(key: string, value: T, ttlMs: number) {
    const k = this.prefix + String(key ?? '').trim();
    if (!k) return;
    const ttl = Math.max(0, Math.floor(ttlMs ?? 0));
    if (ttl <= 0) return;
    await this.redis.raw().set(k, JSON.stringify(value), 'PX', ttl);
  }

  async invalidateForUser(user: { id: string; username: string | null }) {
    const id = String(user.id ?? '').trim();
    const u = (user.username ?? '').trim().toLowerCase();
    const keys = [id ? `${this.prefix}id:${id}` : null, u ? `${this.prefix}username:${u}` : null].filter(Boolean) as string[];
    if (keys.length === 0) return;
    await this.redis.raw().del(...keys);
  }
}

