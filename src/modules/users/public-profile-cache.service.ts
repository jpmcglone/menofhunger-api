import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { RedisKeys } from '../redis/redis-keys';

@Injectable()
export class PublicProfileCacheService<T extends { id: string; username: string | null }> {
  constructor(
    private readonly redis: RedisService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  private async readByUserId(userId: string): Promise<T | null> {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    const ver = await this.cacheInvalidation.profileVersion(uid);
    const k = RedisKeys.publicProfileDataByUserId(uid, ver);
    return await this.redis.getJson<T>(k);
  }

  async read(key: string): Promise<T | null> {
    const rawKey = String(key ?? '').trim();
    if (!rawKey) return null;
    if (rawKey.startsWith('id:')) {
      const userId = rawKey.slice('id:'.length).trim();
      return await this.readByUserId(userId);
    }
    if (rawKey.startsWith('username:')) {
      const username = rawKey.slice('username:'.length).trim().toLowerCase();
      if (!username) return null;
      const userId = await this.redis.getString(RedisKeys.publicProfileUsernameToId(username));
      if (!userId) return null;
      const payload = await this.readByUserId(userId);
      // Safety: if username mapping is stale (username changed), don't return wrong profile.
      const payloadUsername = String((payload as any)?.username ?? '').trim().toLowerCase();
      if (payload && payloadUsername && payloadUsername !== username) {
        // Best-effort cleanup so future reads heal quickly.
        void this.redis.del(RedisKeys.publicProfileUsernameToId(username)).catch(() => undefined);
        return null;
      }
      return payload;
    }
    // Unknown key format.
    return null;
  }

  async write(key: string, value: T, ttlMs: number) {
    const rawKey = String(key ?? '').trim();
    if (!rawKey) return;
    const ttl = Math.max(0, Math.floor(ttlMs ?? 0));
    if (ttl <= 0) return;

    const userId = String((value as any)?.id ?? '').trim();
    if (!userId) return;

    const ver = await this.cacheInvalidation.profileVersion(userId);
    const dataKey = RedisKeys.publicProfileDataByUserId(userId, ver);
    await this.redis.setJson(dataKey, value, { ttlMs: ttl });

    // Best-effort: maintain a short-lived username -> id resolver for versioned reads.
    const username = String((value as any)?.username ?? '').trim().toLowerCase();
    if (username) {
      void this.redis.setString(RedisKeys.publicProfileUsernameToId(username), userId, { ttlMs: ttl }).catch(() => undefined);
    }
  }

  async invalidateForUser(user: { id: string; username: string | null }) {
    const id = String(user.id ?? '').trim();
    const u = (user.username ?? '').trim().toLowerCase();
    if (!id) return;

    // Version bump is the primary invalidation mechanism.
    await this.cacheInvalidation.bumpProfile(id);

    // Cleanup helpers (best-effort): remove username resolver and any legacy unversioned keys.
    const legacyKeys = [
      u ? RedisKeys.publicProfileUsernameToId(u) : null,
      id ? `cache:publicProfile:id:${id}` : null,
      u ? `cache:publicProfile:username:${u}` : null,
    ].filter(Boolean) as string[];
    if (legacyKeys.length > 0) {
      void this.redis.del(...legacyKeys).catch(() => undefined);
    }
  }
}

