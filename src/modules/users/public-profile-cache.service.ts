import { Injectable } from '@nestjs/common';

type CacheEntry<T> = { value: T; expiresAt: number };

@Injectable()
export class PublicProfileCacheService<T extends { id: string; username: string | null }> {
  private cache = new Map<string, CacheEntry<T>>();

  read(key: string): T | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.value;
  }

  write(key: string, value: T, ttlMs: number) {
    this.cache.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
  }

  invalidateForUser(user: { id: string; username: string | null }) {
    this.cache.delete(`id:${user.id}`);
    const u = (user.username ?? '').trim().toLowerCase();
    if (u) this.cache.delete(`username:${u}`);
  }
}

