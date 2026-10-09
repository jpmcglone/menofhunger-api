import { Injectable } from '@nestjs/common';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { PresenceRedisBusService } from './presence-redis-bus.service';
import { PresenceRedisReadService } from './presence-redis-read.service';
import { ANON_SOCKET_TTL_SECONDS, memberForSocket, parseSocketMember } from './presence-socket-member';

/** Guest (signed-out) sockets: registration, heartbeat refresh on this instance, stale-member pruning, and the guest count. */
@Injectable()
export class PresenceAnonymousStateService {
  /** Local guest sockets still connected on this instance (socketId → anonId). */
  private readonly localAnonSockets = new Map<string, string>();

  constructor(
    private readonly redis: RedisService,
    private readonly bus: PresenceRedisBusService,
    private readonly read: PresenceRedisReadService,
  ) {}

  async registerAnonSocket(params: {
    socketId: string;
    anonId: string;
    client: string;
  }): Promise<{ isNewlyOnline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const anonId = String(params.anonId ?? '').trim();
    if (!socketId || !anonId) return { isNewlyOnline: false };

    this.localAnonSockets.set(socketId, anonId);

    const ttlSeconds = ANON_SOCKET_TTL_SECONDS;
    const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
    const socketsKey = RedisKeys.presenceAnonSockets(anonId);
    const member = memberForSocket(this.bus.getInstanceId(), socketId);
    const now = Date.now();

    await Promise.allSettled([
      this.redis.setJson(
        socketKey,
        { anonId, client: String(params.client ?? ''), connectedAtMs: now, lastSeenAtMs: now },
        { ttlSeconds },
      ),
      this.redis.raw().sadd(socketsKey, member),
      this.redis.raw().expire(socketsKey, ttlSeconds),
    ]);

    let isNewlyOnline = false;
    try {
      const added = await this.redis.raw().zadd(RedisKeys.presenceAnonOnlineZset(), 'NX', now, anonId);
      isNewlyOnline = added === 1;
    } catch {
      // ignore
    }

    if (isNewlyOnline) {
      await this.publishAnonymousCount();
    }
    return { isNewlyOnline };
  }

  async unregisterAnonSocket(params: { socketId: string; anonId: string }): Promise<{ isNowOffline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const anonId = String(params.anonId ?? '').trim();
    if (!socketId || !anonId) return { isNowOffline: false };

    this.localAnonSockets.delete(socketId);

    const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
    const socketsKey = RedisKeys.presenceAnonSockets(anonId);
    const member = memberForSocket(this.bus.getInstanceId(), socketId);

    const unregisterLua = `
      redis.call("srem", KEYS[1], ARGV[1])
      redis.call("del", KEYS[2])
      local remaining = redis.call("scard", KEYS[1]) or 0
      if remaining <= 0 then
        redis.call("zrem", KEYS[3], ARGV[2])
        return 1
      end
      return 0
    `;

    let isNowOffline = false;
    try {
      const res = await this.redis
        .raw()
        .eval(unregisterLua, 3, socketsKey, socketKey, RedisKeys.presenceAnonOnlineZset(), member, anonId);
      isNowOffline = Number(res) === 1;
    } catch {
      await Promise.allSettled([this.redis.raw().srem(socketsKey, member), this.redis.del(socketKey)]);
      let remaining = 0;
      try {
        remaining = await this.redis.raw().scard(socketsKey);
      } catch {
        remaining = 0;
      }
      isNowOffline = remaining <= 0;
      if (isNowOffline) {
        await Promise.allSettled([this.redis.raw().zrem(RedisKeys.presenceAnonOnlineZset(), anonId)]);
      }
    }

    if (isNowOffline) {
      await this.publishAnonymousCount();
    }
    return { isNowOffline };
  }

  async publishAnonymousCount(): Promise<void> {
    const anonymousOnline = await this.read.anonymousOnlineCount();
    await this.bus.publish({ type: 'anonymousCount', instanceId: this.bus.getInstanceId(), anonymousOnline });
  }

  private async refreshLocalAnonHeartbeats(): Promise<void> {
    if (this.localAnonSockets.size === 0) return;
    const ttlSeconds = ANON_SOCKET_TTL_SECONDS;
    const now = Date.now();
    for (const [socketId, anonId] of this.localAnonSockets) {
      const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
      let connectedAtMs = now;
      try {
        const existing = await this.redis.getJson<{ connectedAtMs?: unknown }>(socketKey);
        const existingConnectedAtMs = Number(existing?.connectedAtMs);
        if (Number.isFinite(existingConnectedAtMs)) connectedAtMs = existingConnectedAtMs;
      } catch {
        // rebuild from this refresh
      }
      await Promise.allSettled([
        this.redis.setJson(
          socketKey,
          { anonId, connectedAtMs, lastSeenAtMs: now },
          { ttlSeconds },
        ),
        this.redis.raw().expire(RedisKeys.presenceAnonSockets(anonId), ttlSeconds),
      ]);
    }
  }

  private async pruneStaleAnonSocketMembers(anonId: string): Promise<number> {
    const id = String(anonId ?? '').trim();
    if (!id) return 0;
    const socketsKey = RedisKeys.presenceAnonSockets(id);
    let members: string[] = [];
    try {
      members = (await this.redis.raw().smembers(socketsKey)) ?? [];
    } catch {
      return 0;
    }
    if (members.length === 0) return 0;

    const stale: string[] = [];
    const refs: Array<{ member: string; instanceId: string; socketId: string }> = [];
    for (const member of members) {
      const parsed = parseSocketMember(member);
      if (!parsed) {
        stale.push(member);
        continue;
      }
      refs.push({ member, ...parsed });
    }

    if (refs.length > 0) {
      const pipe = this.redis.raw().pipeline();
      for (const ref of refs) {
        pipe.exists(RedisKeys.presenceSocket(ref.instanceId, ref.socketId));
      }
      let results: Array<[Error | null, unknown]> | null = null;
      try {
        results = await pipe.exec();
      } catch {
        results = null;
      }
      for (let i = 0; i < refs.length; i++) {
        const exists = Number(results?.[i]?.[1] ?? 0) === 1;
        if (!exists) stale.push(refs[i]!.member);
      }
    }

    if (stale.length === 0) return 0;
    try {
      await this.redis.raw().srem(socketsKey, ...stale);
    } catch {
      return 0;
    }
    return stale.length;
  }

  async sweepOfflineAnons(): Promise<void> {
    await this.refreshLocalAnonHeartbeats();

    let anonIds: string[] = [];
    try {
      anonIds = await this.redis.raw().zrange(RedisKeys.presenceAnonOnlineZset(), 0, 2000);
    } catch {
      return;
    }
    if (anonIds.length === 0) return;

    let dropped = 0;
    for (const rawId of anonIds) {
      const anonId = String(rawId ?? '').trim();
      if (!anonId) continue;
      await this.pruneStaleAnonSocketMembers(anonId).catch(() => 0);
      let remaining = 0;
      try {
        remaining = await this.redis.raw().scard(RedisKeys.presenceAnonSockets(anonId));
      } catch {
        remaining = 0;
      }
      if (remaining > 0) continue;
      await Promise.allSettled([this.redis.raw().zrem(RedisKeys.presenceAnonOnlineZset(), anonId)]);
      dropped += 1;
    }
    if (dropped > 0) {
      await this.publishAnonymousCount();
    }
  }
}
