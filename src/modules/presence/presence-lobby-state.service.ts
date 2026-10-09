import { Injectable } from '@nestjs/common';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { PresenceRedisBusService } from './presence-redis-bus.service';

/** Space lobby occupancy shared across instances: summed counts and the vacant-since stamp. */
@Injectable()
export class PresenceLobbyStateService {
  constructor(
    private readonly redis: RedisService,
    private readonly bus: PresenceRedisBusService,
  ) {}

  /**
   * Persist this instance's local lobby counts, then return the sum across all
   * live instances (crashed instances expire via TTL / empty prune).
   */
  async syncAndAggregateLobbyCounts(localCounts: Record<string, number>): Promise<Record<string, number>> {
    const inst = this.bus.getInstanceId();
    const instKey = RedisKeys.spacesLobbyCountsInstance(inst);
    const setKey = RedisKeys.spacesLobbyCountsInstances();
    // Short TTL: ghost membership after a process death should clear quickly.
    const ttl = 45;
    try {
      const raw = this.redis.raw();
      const entries = Object.entries(localCounts).filter(([, n]) => Number(n) > 0);
      const pipe = raw.pipeline();
      pipe.del(instKey);
      if (entries.length > 0) {
        const flat: string[] = [];
        for (const [spaceId, n] of entries) {
          flat.push(spaceId, String(Math.max(0, Math.floor(n))));
        }
        pipe.hset(instKey, ...flat);
        pipe.expire(instKey, ttl);
        pipe.sadd(setKey, inst);
      } else {
        // No local members — drop this instance from the roster so empty
        // processes don't keep the set warm for stale peers.
        pipe.srem(setKey, inst);
      }
      pipe.expire(setKey, ttl);
      await pipe.exec();

      const instances = await raw.smembers(setKey);
      const totals: Record<string, number> = {};
      if (instances.length === 0) return {};
      const getPipe = raw.pipeline();
      for (const id of instances) {
        getPipe.hgetall(RedisKeys.spacesLobbyCountsInstance(id));
      }
      const rows = await getPipe.exec();
      const prune: string[] = [];
      for (let i = 0; i < instances.length; i++) {
        const hash = (rows?.[i]?.[1] ?? {}) as Record<string, string>;
        const keys = Object.keys(hash);
        if (keys.length === 0) {
          prune.push(instances[i]);
          continue;
        }
        for (const [spaceId, val] of Object.entries(hash)) {
          const n = Math.max(0, Math.floor(Number(val) || 0));
          if (!n) continue;
          totals[spaceId] = (totals[spaceId] ?? 0) + n;
        }
      }
      if (prune.length > 0) {
        await raw.srem(setKey, ...prune);
      }
      return totals;
    } catch {
      return { ...localCounts };
    }
  }

  async clearSpaceEmptySince(spaceIdRaw: string): Promise<void> {
    const spaceId = String(spaceIdRaw ?? '').trim();
    if (!spaceId) return;
    try {
      await this.redis.raw().del(RedisKeys.spacesEmptySince(spaceId));
    } catch {
      // best-effort
    }
  }

  /**
   * Stamp empty-since once (SET NX). Returns epoch ms for a vacant lobby, or null if occupied.
   */
  async ensureSpaceEmptySince(spaceIdRaw: string, locallyOccupied: boolean): Promise<number | null> {
    const spaceId = String(spaceIdRaw ?? '').trim();
    if (!spaceId) return null;
    if (locallyOccupied) {
      await this.clearSpaceEmptySince(spaceId);
      return null;
    }
    const key = RedisKeys.spacesEmptySince(spaceId);
    const now = Date.now();
    try {
      const raw = this.redis.raw();
      const set = await raw.set(key, String(now), 'NX');
      if (set === 'OK') return now;
      const existing = await raw.get(key);
      const n = Number(existing);
      return Number.isFinite(n) && n > 0 ? n : now;
    } catch {
      return now;
    }
  }
}
