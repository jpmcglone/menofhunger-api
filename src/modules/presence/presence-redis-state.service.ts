import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type Redis from 'ioredis';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { AppConfigService } from '../app/app-config.service';

type PresenceEvent =
  | { type: 'online'; userId: string; instanceId: string }
  | { type: 'offline'; userId: string; instanceId: string }
  | { type: 'idle'; userId: string; instanceId: string }
  | { type: 'active'; userId: string; instanceId: string }
  | { type: 'emitToUser'; userId: string; instanceId: string; event: string; payload: unknown }
  | { type: 'emitToRoom'; userId: string; instanceId: string; room: string; event: string; payload: unknown };

@Injectable()
export class PresenceRedisStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceRedisStateService.name);
  private readonly instanceId = crypto.randomUUID().slice(0, 12);
  private readonly sub: Redis;
  private readonly listeners = new Set<(evt: PresenceEvent) => void>();

  constructor(
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
  ) {
    this.sub = this.redis.duplicate();
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  private socketTtlSeconds(): number {
    // TTL fallback should outlive idle-disconnect so crashed instances don't leave users "online" forever.
    const baseMs = this.appConfig.presenceIdleDisconnectMinutes() * 60 * 1000;
    return Math.max(60, Math.ceil((baseMs + 60_000) / 1000));
  }

  private memberForSocket(socketId: string): string {
    return `${this.instanceId}:${String(socketId ?? '').trim()}`;
  }

  private parseMember(member: string): { instanceId: string; socketId: string } | null {
    const m = String(member ?? '').trim();
    const idx = m.indexOf(':');
    if (idx <= 0) return null;
    const inst = m.slice(0, idx).trim();
    const sid = m.slice(idx + 1).trim();
    if (!inst || !sid) return null;
    return { instanceId: inst, socketId: sid };
  }

  private async publish(evt: PresenceEvent): Promise<void> {
    try {
      await this.redis.raw().publish(RedisKeys.presencePubSubChannel(), JSON.stringify(evt));
    } catch {
      // best-effort
    }
  }

  onEvent(handler: (evt: PresenceEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.sub.subscribe(RedisKeys.presencePubSubChannel());
      this.sub.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message) as PresenceEvent;
          if (!parsed || typeof (parsed as any).type !== 'string' || typeof (parsed as any).userId !== 'string') return;
          for (const fn of this.listeners) {
            try {
              fn(parsed);
            } catch {
              // ignore listener failures
            }
          }
        } catch {
          // ignore
        }
      });
    } catch (err) {
      this.logger.warn(`[presence] Failed to subscribe to pubsub: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.sub.quit();
    } catch {
      this.sub.disconnect();
    }
  }

  async registerSocket(params: { socketId: string; userId: string; client: string }): Promise<{ isNewlyOnline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return { isNewlyOnline: false };

    const ttlSeconds = this.socketTtlSeconds();
    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
    const userSocketsKey = RedisKeys.presenceUserSockets(userId);
    const member = this.memberForSocket(socketId);
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
      await this.publish({ type: 'online', userId, instanceId: this.instanceId });
    }
    return { isNewlyOnline };
  }

  async unregisterSocket(params: { socketId: string; userId: string }): Promise<{ isNowOffline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return { isNowOffline: false };

    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
    const userSocketsKey = RedisKeys.presenceUserSockets(userId);
    const member = this.memberForSocket(socketId);

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
      await this.publish({ type: 'offline', userId, instanceId: this.instanceId });
    }
    return { isNowOffline };
  }

  async touchSocket(params: { socketId: string; userId: string; client: string }): Promise<void> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return;
    const ttlSeconds = this.socketTtlSeconds();
    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
    const now = Date.now();
    // Refresh heartbeat + TTL best-effort.
    void this.redis
      .setJson(socketKey, { userId, client: String(params.client ?? ''), lastSeenAtMs: now }, { ttlSeconds })
      .catch(() => undefined);
    void this.redis.raw().expire(RedisKeys.presenceUserSockets(userId), ttlSeconds).catch(() => undefined);
  }

  async setIdle(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    await Promise.allSettled([
      this.redis.raw().sadd(RedisKeys.presenceIdleSet(), uid),
      this.publish({ type: 'idle', userId: uid, instanceId: this.instanceId }),
    ]);
  }

  async setActive(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    await Promise.allSettled([
      this.redis.raw().srem(RedisKeys.presenceIdleSet(), uid),
      this.publish({ type: 'active', userId: uid, instanceId: this.instanceId }),
    ]);
  }

  /**
   * Cross-instance targeted emit (best-effort).
   * Each instance will deliver to its local sockets for the user.
   */
  async publishEmitToUser(params: { userId: string; event: string; payload: unknown }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!userId || !event) return;
    await this.publish({ type: 'emitToUser', userId, instanceId: this.instanceId, event, payload: params.payload });
  }

  /**
   * Cross-instance room emit (best-effort).
   * Used for scoped subscriptions (e.g. per-post live updates).
   */
  async publishEmitToRoom(params: { room: string; event: string; payload: unknown }): Promise<void> {
    const room = String(params.room ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!room || !event) return;
    // `userId` remains required by the pubsub envelope; use '-' for room emits.
    await this.publish({ type: 'emitToRoom', userId: '-', instanceId: this.instanceId, room, event, payload: params.payload });
  }

  async isIdle(userId: string): Promise<boolean> {
    const uid = String(userId ?? '').trim();
    if (!uid) return false;
    try {
      const res = await this.redis.raw().sismember(RedisKeys.presenceIdleSet(), uid);
      return res === 1;
    } catch {
      return false;
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    const uid = String(userId ?? '').trim();
    if (!uid) return false;
    try {
      const score = await this.redis.raw().zscore(RedisKeys.presenceOnlineZset(), uid);
      return score != null;
    } catch {
      return false;
    }
  }

  async onlineByUserIds(userIds: string[]): Promise<Map<string, boolean>> {
    const ids = (userIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
    const out = new Map<string, boolean>();
    if (ids.length === 0) return out;
    try {
      // Prefer zset score bulk read (faster than N zscore calls).
      const scores = await this.lastConnectAtMsByUserId(ids);
      for (const id of ids) out.set(id, scores.get(id) != null);
      return out;
    } catch {
      // Fallback: pipeline zscore.
      try {
        const pipe = this.redis.raw().pipeline();
        for (const id of ids) pipe.zscore(RedisKeys.presenceOnlineZset(), id);
        const res = await pipe.exec();
        for (let i = 0; i < ids.length; i++) {
          const raw = res?.[i]?.[1];
          out.set(ids[i]!, raw != null);
        }
      } catch {
        for (const id of ids) out.set(id, false);
      }
      return out;
    }
  }

  async idleByUserIds(userIds: string[]): Promise<Map<string, boolean>> {
    const ids = (userIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
    const out = new Map<string, boolean>();
    if (ids.length === 0) return out;
    try {
      const pipe = this.redis.raw().pipeline();
      for (const id of ids) pipe.sismember(RedisKeys.presenceIdleSet(), id);
      const res = await pipe.exec();
      for (let i = 0; i < ids.length; i++) {
        const raw = res?.[i]?.[1];
        out.set(ids[i]!, raw === 1);
      }
    } catch {
      for (const id of ids) out.set(id, false);
    }
    return out;
  }

  async onlineUserIds(): Promise<string[]> {
    try {
      // zset is connectAt; return earliest first (longest online first) to match existing UI sort.
      return await this.redis.raw().zrange(RedisKeys.presenceOnlineZset(), 0, -1);
    } catch {
      return [];
    }
  }

  async lastConnectAtMsByUserId(userIds: string[]): Promise<Map<string, number | null>> {
    const ids = (userIds ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
    const out = new Map<string, number | null>();
    if (ids.length === 0) return out;
    try {
      const scores = await (this.redis.raw() as any).zmscore(RedisKeys.presenceOnlineZset(), ...ids);
      for (let i = 0; i < ids.length; i++) {
        const raw = scores?.[i];
        const n = raw == null ? null : Number(raw);
        out.set(ids[i]!, Number.isFinite(n as number) ? Math.floor(n as number) : null);
      }
    } catch {
      // Fallback for older Redis versions without ZMSCORE.
      try {
        const pipe = this.redis.raw().pipeline();
        for (const id of ids) pipe.zscore(RedisKeys.presenceOnlineZset(), id);
        const res = await pipe.exec();
        for (let i = 0; i < ids.length; i++) {
          const raw = res?.[i]?.[1];
          const n = raw == null ? null : Number(raw);
          out.set(ids[i]!, Number.isFinite(n as number) ? Math.floor(n as number) : null);
        }
      } catch {
        for (const id of ids) out.set(id, null);
      }
    }
    return out;
  }

  async socketIdsForUserOnThisInstance(userId: string): Promise<string[]> {
    const uid = String(userId ?? '').trim();
    if (!uid) return [];
    const members = await this.redis.raw().smembers(RedisKeys.presenceUserSockets(uid));
    const ids: string[] = [];
    for (const m of members ?? []) {
      const parsed = this.parseMember(m);
      if (parsed?.instanceId !== this.instanceId) continue;
      ids.push(parsed.socketId);
    }
    return ids;
  }

  // TTL fallback: periodically prune users that have no sockets left.
  @Interval(30_000)
  async sweepOfflineUsers(): Promise<void> {
    // Keep this bounded; we only need eventual correctness for crash cleanup.
    let userIds: string[] = [];
    try {
      userIds = await this.redis.raw().zrange(RedisKeys.presenceOnlineZset(), 0, 2000);
    } catch {
      return;
    }
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      const uid = String(userId ?? '').trim();
      if (!uid) continue;
      let remaining = 0;
      try {
        remaining = await this.redis.raw().scard(RedisKeys.presenceUserSockets(uid));
      } catch {
        remaining = 0;
      }
      if (remaining > 0) continue;

      // No sockets tracked => offline.
      await Promise.allSettled([
        this.redis.raw().zrem(RedisKeys.presenceOnlineZset(), uid),
        this.redis.raw().srem(RedisKeys.presenceIdleSet(), uid),
      ]);
      await this.publish({ type: 'offline', userId: uid, instanceId: this.instanceId });
    }
  }
}

