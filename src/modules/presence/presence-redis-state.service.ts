import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { AppConfigService } from '../app/app-config.service';
import { PresenceService } from './presence.service';
import { PresenceAnonymousStateService } from './presence-anonymous-state.service';
import { PresenceRedisBusService } from './presence-redis-bus.service';
import { PresenceRedisReadService } from './presence-redis-read.service';
import { memberForSocket, parseSocketMember, socketTtlSeconds } from './presence-socket-member';

/**
 * Presence state in Redis for signed-in users: socket registration and heartbeat, idle flags, and the
 * stale-socket sweep. The bus, reads, guests, and lobby counts live in their own services; inject those
 * directly rather than going through this one.
 */
@Injectable()
export class PresenceRedisStateService {
  constructor(
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
    private readonly presence: PresenceService,
    private readonly bus: PresenceRedisBusService,
    private readonly read: PresenceRedisReadService,
    private readonly anon: PresenceAnonymousStateService,
  ) {}

  async registerSocket(params: { socketId: string; userId: string; client: string }): Promise<{ isNewlyOnline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return { isNewlyOnline: false };

    const ttlSeconds = socketTtlSeconds(this.appConfig.presenceIdleDisconnectMinutes());
    const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
    const userSocketsKey = RedisKeys.presenceUserSockets(userId);
    const member = memberForSocket(this.bus.getInstanceId(), socketId);
    const now = Date.now();

    // socketKey is the heartbeat/TTL primitive; userSocketsKey is used for deterministic offline on disconnect.
    await Promise.allSettled([
      this.redis.setJson(socketKey, { userId, client: String(params.client ?? ''), connectedAtMs: now, lastSeenAtMs: now }, { ttlSeconds }),
      this.redis.raw().sadd(userSocketsKey, member),
      this.redis.raw().expire(userSocketsKey, ttlSeconds),
    ]);

    // "Online since" zset: connectAt, stable during the session. Only set on first socket (ZADD NX).
    let isNewlyOnline = false;
    try {
      const added = await this.redis.raw().zadd(RedisKeys.presenceOnlineZset(), 'NX', now, userId);
      isNewlyOnline = added === 1;
    } catch {
      // ignore
    }

    if (isNewlyOnline) {
      await this.bus.publish({ type: 'online', userId, instanceId: this.bus.getInstanceId() });
    } else {
      const platforms = (await this.read.platformsByUserIds([userId])).get(userId) ?? [];
      await this.bus.publish({ type: 'platformsChanged', userId, instanceId: this.bus.getInstanceId(), platforms });
    }
    return { isNewlyOnline };
  }

  async unregisterSocket(params: { socketId: string; userId: string }): Promise<{ isNowOffline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return { isNowOffline: false };

    const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
    const userSocketsKey = RedisKeys.presenceUserSockets(userId);
    const member = memberForSocket(this.bus.getInstanceId(), socketId);

    // Atomic unregister: prevent races where a reconnect happens between SCARD and ZREM.
    const unregisterLua = `
      redis.call("srem", KEYS[1], ARGV[1])
      redis.call("del", KEYS[2])
      local remaining = redis.call("scard", KEYS[1]) or 0
      if remaining <= 0 then
        redis.call("zrem", KEYS[3], ARGV[2])
        redis.call("srem", KEYS[4], ARGV[2])
        return 1
      end
      return 0
    `;

    let isNowOffline = false;
    try {
      const res = await this.redis
        .raw()
        .eval(
          unregisterLua,
          4,
          userSocketsKey,
          socketKey,
          RedisKeys.presenceOnlineZset(),
          RedisKeys.presenceIdleSet(),
          member,
          userId,
        );
      isNowOffline = Number(res) === 1;
    } catch {
      // Best-effort fallback (non-atomic).
      await Promise.allSettled([this.redis.raw().srem(userSocketsKey, member), this.redis.del(socketKey)]);
      let remaining = 0;
      try {
        remaining = await this.redis.raw().scard(userSocketsKey);
      } catch {
        remaining = 0;
      }
      isNowOffline = remaining <= 0;
      if (isNowOffline) {
        await Promise.allSettled([
          this.redis.raw().zrem(RedisKeys.presenceOnlineZset(), userId),
          this.redis.raw().srem(RedisKeys.presenceIdleSet(), userId),
        ]);
      }
    }

    if (isNowOffline) {
      await this.bus.publish({ type: 'offline', userId, instanceId: this.bus.getInstanceId() });
    } else {
      const platforms = (await this.read.platformsByUserIds([userId])).get(userId) ?? [];
      await this.bus.publish({ type: 'platformsChanged', userId, instanceId: this.bus.getInstanceId(), platforms });
    }
    return { isNowOffline };
  }

  async touchSocket(params: { socketId: string; userId: string; client: string }): Promise<void> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return;
    const ttlSeconds = socketTtlSeconds(this.appConfig.presenceIdleDisconnectMinutes());
    const socketKey = RedisKeys.presenceSocket(this.bus.getInstanceId(), socketId);
    const now = Date.now();
    // Preserve the original connection time while refreshing heartbeat + TTL.
    // Platform ordering must not change merely because one client heartbeats.
    let connectedAtMs = now;
    try {
      const existing = await this.redis.getJson<{ connectedAtMs?: unknown }>(socketKey);
      const existingConnectedAtMs = Number(existing?.connectedAtMs);
      if (Number.isFinite(existingConnectedAtMs)) connectedAtMs = existingConnectedAtMs;
    } catch {
      // A missing/expired socket record is safely rebuilt from this heartbeat.
    }
    await Promise.allSettled([
      this.redis.setJson(
        socketKey,
        { userId, client: String(params.client ?? ''), connectedAtMs, lastSeenAtMs: now },
        { ttlSeconds },
      ),
      this.redis.raw().expire(RedisKeys.presenceUserSockets(userId), ttlSeconds),
    ]);
  }

  async setIdle(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    await Promise.allSettled([
      this.redis.raw().sadd(RedisKeys.presenceIdleSet(), uid),
      this.bus.publish({ type: 'idle', userId: uid, instanceId: this.bus.getInstanceId() }),
    ]);
  }

  async setActive(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    await Promise.allSettled([
      this.redis.raw().srem(RedisKeys.presenceIdleSet(), uid),
      this.bus.publish({ type: 'active', userId: uid, instanceId: this.bus.getInstanceId() }),
    ]);
  }

  /**
   * Drop `presence:user:{id}:sockets` members whose socket heartbeat key is gone.
   * Socket keys TTL-expire on crash, but set members only leave via unregister — without
   * this, zombies keep users "online" and inflate platform lookups forever.
   */
  async pruneStaleSocketMembers(userId: string): Promise<number> {
    const uid = String(userId ?? '').trim();
    if (!uid) return 0;
    const userSocketsKey = RedisKeys.presenceUserSockets(uid);
    let members: string[] = [];
    try {
      members = (await this.redis.raw().smembers(userSocketsKey)) ?? [];
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
      await this.redis.raw().srem(userSocketsKey, ...stale);
    } catch {
      return 0;
    }
    return stale.length;
  }

  // TTL fallback: periodically prune zombie socket-set members, then mark users
  // with no remaining sockets as offline.
  @Interval(30_000)
  async sweepOfflineUsers(): Promise<void> {
    // Keep this bounded; we only need eventual correctness for crash cleanup.
    let userIds: string[] = [];
    try {
      userIds = await this.redis.raw().zrange(RedisKeys.presenceOnlineZset(), 0, 2000);
    } catch {
      userIds = [];
    }

    for (const userId of userIds) {
      const uid = String(userId ?? '').trim();
      if (!uid) continue;
      await this.pruneStaleSocketMembers(uid).catch(() => 0);
      let remaining = 0;
      try {
        remaining = await this.redis.raw().scard(RedisKeys.presenceUserSockets(uid));
      } catch {
        remaining = 0;
      }
      if (remaining > 0) continue;

      // No sockets tracked => offline. Persist lastOnlineAt so the user appears in
      // "recently around" even if the process crashed before handleDisconnect ran.
      this.presence.persistLastOnlineAt(uid);
      this.presence.clearPersistThrottle(uid);
      await Promise.allSettled([
        this.redis.raw().zrem(RedisKeys.presenceOnlineZset(), uid),
        this.redis.raw().srem(RedisKeys.presenceIdleSet(), uid),
      ]);
      await this.bus.publish({ type: 'offline', userId: uid, instanceId: this.bus.getInstanceId() });
    }

    await this.anon.sweepOfflineAnons();
  }
}

