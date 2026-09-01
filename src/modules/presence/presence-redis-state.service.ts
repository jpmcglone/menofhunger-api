import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type Redis from 'ioredis';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { AppConfigService } from '../app/app-config.service';
import { PresenceService } from './presence.service';

type PresenceEvent =
  | { type: 'online'; userId: string; instanceId: string }
  | { type: 'offline'; userId: string; instanceId: string }
  | { type: 'idle'; userId: string; instanceId: string }
  | { type: 'active'; userId: string; instanceId: string }
  | { type: 'platformsChanged'; userId: string; instanceId: string; platforms: string[] }
  | { type: 'emitToUser'; userId: string; instanceId: string; event: string; payload: unknown }
  | { type: 'emitToRoom'; userId: string; instanceId: string; room: string; event: string; payload: unknown }
  | { type: 'broadcast'; instanceId: string; event: string; payload: unknown }
  | { type: 'userStatusChanged'; userId: string; instanceId: string; event: string; payload: unknown }
  | { type: 'spacesLobbyCounts'; instanceId: string; countsBySpaceId: Record<string, number> }
  | {
      type: 'userSpaceChanged';
      userId: string;
      instanceId: string;
      spaceId: string | null;
      previousSpaceId?: string;
    }
  | { type: 'anonymousCount'; instanceId: string; anonymousOnline: number };

const INSTANCE_HEARTBEAT_MS = 20_000;
const INSTANCE_HEARTBEAT_TTL_SECONDS = 60;

@Injectable()
export class PresenceRedisStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceRedisStateService.name);
  private readonly instanceId = crypto.randomUUID().slice(0, 12);
  private readonly sub: Redis;
  private readonly listeners = new Set<(evt: PresenceEvent) => void>();
  /** Local guest sockets still connected on this instance (socketId → anonId). */
  private readonly localAnonSockets = new Map<string, string>();

  constructor(
    private readonly redis: RedisService,
    private readonly appConfig: AppConfigService,
    private readonly presence: PresenceService,
  ) {
    // Subscriber connections must not run the ready-check: ioredis sends INFO
    // for the check, which is rejected in subscriber mode after a reconnect.
    this.sub = this.redis.duplicate({ enableReadyCheck: false });
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  private socketTtlSeconds(): number {
    // TTL fallback should outlive idle-disconnect so crashed instances don't leave users "online" forever.
    const baseMs = this.appConfig.presenceIdleDisconnectMinutes() * 60 * 1000;
    return Math.max(60, Math.ceil((baseMs + 60_000) / 1000));
  }

  private anonSocketTtlSeconds(): number {
    // Live guests are refreshed every 30s. Keep this short so a crashed or
    // `--watch`-restarted API instance cannot leave ghost guests for the full
    // member idle TTL (~15 min).
    return 120;
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

  /**
   * Instance liveness beacon. Socket heartbeat keys outlive idle-disconnect (~16 min), so on
   * their own they can't tell "socket on a crashed/restarted instance" from "socket on a
   * healthy peer" for a long time. This key expires within a minute of a process dying.
   */
  @Interval(INSTANCE_HEARTBEAT_MS)
  async heartbeatInstance(): Promise<void> {
    try {
      await this.redis.setString(RedisKeys.presenceInstance(this.instanceId), '1', {
        ttlSeconds: INSTANCE_HEARTBEAT_TTL_SECONDS,
      });
    } catch {
      // Next tick retries; a missed beat only shortens the grace for our sockets.
    }
  }

  /**
   * Socket ids of `userId` that are provably still connected somewhere: registered in the
   * user's socket set, on an instance that is still beating, with a live heartbeat key.
   */
  async liveSocketIdsForUser(userId: string): Promise<Set<string>> {
    const uid = String(userId ?? '').trim();
    const out = new Set<string>();
    if (!uid) return out;
    let members: string[] = [];
    try {
      members = (await this.redis.raw().smembers(RedisKeys.presenceUserSockets(uid))) ?? [];
    } catch {
      return out;
    }
    const refs = members.map((m) => this.parseMember(m)).filter((r): r is { instanceId: string; socketId: string } => r !== null);
    if (refs.length === 0) return out;
    const pipe = this.redis.raw().pipeline();
    for (const ref of refs) {
      pipe.exists(RedisKeys.presenceInstance(ref.instanceId));
      pipe.exists(RedisKeys.presenceSocket(ref.instanceId, ref.socketId));
    }
    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = await pipe.exec();
    } catch {
      results = null;
    }
    if (!results) return out;
    refs.forEach((ref, i) => {
      const instanceAlive = Number(results[i * 2]?.[1] ?? 0) === 1;
      const socketAlive = Number(results[i * 2 + 1]?.[1] ?? 0) === 1;
      if (instanceAlive && socketAlive) out.add(ref.socketId);
    });
    return out;
  }

  async onModuleInit(): Promise<void> {
    await this.heartbeatInstance();
    try {
      await this.sub.subscribe(RedisKeys.presencePubSubChannel());
      this.sub.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message) as PresenceEvent;
          if (!parsed || typeof (parsed as any).type !== 'string') return;
          // Most events require userId; these types are count/broadcast-only.
          const typesWithoutUserId = new Set(['spacesLobbyCounts', 'broadcast', 'anonymousCount']);
          if (!typesWithoutUserId.has((parsed as any).type) && typeof (parsed as any).userId !== 'string') return;
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
    } else {
      const platforms = (await this.platformsByUserIds([userId])).get(userId) ?? [];
      await this.publish({ type: 'platformsChanged', userId, instanceId: this.instanceId, platforms });
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
    } else {
      const platforms = (await this.platformsByUserIds([userId])).get(userId) ?? [];
      await this.publish({ type: 'platformsChanged', userId, instanceId: this.instanceId, platforms });
    }
    return { isNowOffline };
  }

  async anonymousOnlineCount(): Promise<number> {
    try {
      const n = await this.redis.raw().zcard(RedisKeys.presenceAnonOnlineZset());
      return Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
    } catch {
      return 0;
    }
  }

  async registerAnonSocket(params: {
    socketId: string;
    anonId: string;
    client: string;
  }): Promise<{ isNewlyOnline: boolean }> {
    const socketId = String(params.socketId ?? '').trim();
    const anonId = String(params.anonId ?? '').trim();
    if (!socketId || !anonId) return { isNewlyOnline: false };

    this.localAnonSockets.set(socketId, anonId);

    const ttlSeconds = this.anonSocketTtlSeconds();
    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
    const socketsKey = RedisKeys.presenceAnonSockets(anonId);
    const member = this.memberForSocket(socketId);
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

    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
    const socketsKey = RedisKeys.presenceAnonSockets(anonId);
    const member = this.memberForSocket(socketId);

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

  private async publishAnonymousCount(): Promise<void> {
    const anonymousOnline = await this.anonymousOnlineCount();
    await this.publish({ type: 'anonymousCount', instanceId: this.instanceId, anonymousOnline });
  }

  private async refreshLocalAnonHeartbeats(): Promise<void> {
    if (this.localAnonSockets.size === 0) return;
    const ttlSeconds = this.anonSocketTtlSeconds();
    const now = Date.now();
    for (const [socketId, anonId] of this.localAnonSockets) {
      const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
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
      const parsed = this.parseMember(member);
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

  private async sweepOfflineAnons(): Promise<void> {
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

  async touchSocket(params: { socketId: string; userId: string; client: string }): Promise<void> {
    const socketId = String(params.socketId ?? '').trim();
    const userId = String(params.userId ?? '').trim();
    if (!socketId || !userId) return;
    const ttlSeconds = this.socketTtlSeconds();
    const socketKey = RedisKeys.presenceSocket(this.instanceId, socketId);
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
   * Cross-instance broadcast of space lobby counts.
   * All instances will emit the updated counts to all their connected sockets.
   */
  async publishSpacesLobbyCounts(countsBySpaceId: Record<string, number>): Promise<void> {
    await this.publish({ type: 'spacesLobbyCounts', instanceId: this.instanceId, countsBySpaceId });
  }

  /**
   * Persist this instance's local lobby counts, then return the sum across all
   * live instances (crashed instances expire via TTL / empty prune).
   */
  async syncAndAggregateLobbyCounts(localCounts: Record<string, number>): Promise<Record<string, number>> {
    const inst = this.instanceId;
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

  /**
   * Cross-instance: notify subscribers of a user that their space changed.
   * Each instance emits to its local subscribers of that user.
   */
  async publishUserSpaceChanged(params: {
    userId: string;
    spaceId: string | null;
    previousSpaceId?: string;
  }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    if (!userId) return;
    await this.publish({
      type: 'userSpaceChanged',
      userId,
      instanceId: this.instanceId,
      spaceId: params.spaceId ?? null,
      previousSpaceId: params.previousSpaceId,
    });
  }

  /**
   * Cross-instance: notify subscribers of a user that their plain-text status changed.
   * Each instance emits to its local subscribers of that user.
   */
  async publishUserStatusChanged(params: { userId: string; event: string; payload: unknown }): Promise<void> {
    const userId = String(params.userId ?? '').trim();
    const event = String(params.event ?? '').trim();
    if (!userId || !event) return;
    await this.publish({
      type: 'userStatusChanged',
      userId,
      instanceId: this.instanceId,
      event,
      payload: params.payload,
    });
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

  /**
   * Cross-instance global broadcast (best-effort). Every instance re-emits to all of its
   * connected sockets. Needed so broadcasts originating from a worker process (which has no
   * Socket.IO server of its own) still reach clients.
   */
  async publishBroadcast(params: { event: string; payload: unknown }): Promise<void> {
    const event = String(params.event ?? '').trim();
    if (!event) return;
    await this.publish({ type: 'broadcast', instanceId: this.instanceId, event, payload: params.payload });
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

  /**
   * Cross-instance: true when the user has a non-idle iOS socket somewhere.
   * Used to skip badge-only APNs (socket already drives the icon); web-only
   * presence must NOT suppress iOS home-screen badge sync.
   */
  async isUserActivelyOnIos(userId: string): Promise<boolean> {
    const uid = String(userId ?? '').trim();
    if (!uid) return false;
    if (await this.isIdle(uid)) return false;
    const platforms = (await this.platformsByUserIds([uid])).get(uid) ?? [];
    return platforms.includes('ios');
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

  async platformsByUserIds(userIds: string[]): Promise<Map<string, string[]>> {
    const ids = Array.from(new Set((userIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)));
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return out;

    try {
      const memberPipe = this.redis.raw().pipeline();
      for (const id of ids) memberPipe.smembers(RedisKeys.presenceUserSockets(id));
      const memberResults = await memberPipe.exec();
      const socketRefs: Array<{ userId: string; instanceId: string; socketId: string }> = [];

      for (let index = 0; index < ids.length; index++) {
        const members = Array.isArray(memberResults?.[index]?.[1])
          ? (memberResults?.[index]?.[1] as string[])
          : [];
        for (const member of members) {
          const parsed = this.parseMember(member);
          if (parsed) socketRefs.push({ userId: ids[index]!, ...parsed });
        }
      }

      const socketPipe = this.redis.raw().pipeline();
      for (const ref of socketRefs) {
        socketPipe.get(RedisKeys.presenceSocket(ref.instanceId, ref.socketId));
      }
      const socketResults = socketRefs.length > 0 ? await socketPipe.exec() : [];
      const metadataByUser = new Map<string, Array<{ client: string; connectedAtMs: number }>>();

      for (let index = 0; index < socketRefs.length; index++) {
        const raw = socketResults?.[index]?.[1];
        if (typeof raw !== 'string') continue;
        try {
          const metadata = JSON.parse(raw) as {
            client?: unknown;
            connectedAtMs?: unknown;
            lastSeenAtMs?: unknown;
          };
          const client = String(metadata.client ?? '').trim().toLowerCase();
          if (!client) continue;
          const connectedAtMs = Number(metadata.connectedAtMs ?? metadata.lastSeenAtMs);
          const list = metadataByUser.get(socketRefs[index]!.userId) ?? [];
          list.push({
            client,
            connectedAtMs: Number.isFinite(connectedAtMs) ? connectedAtMs : 0,
          });
          metadataByUser.set(socketRefs[index]!.userId, list);
        } catch {
          // Ignore an expired or malformed socket metadata entry.
        }
      }

      for (const id of ids) {
        const ordered = (metadataByUser.get(id) ?? [])
          .sort((a, b) => b.connectedAtMs - a.connectedAtMs)
          .map((entry) => entry.client);
        const local = this.presence.getClientsForUser(id).map((client) => String(client).trim().toLowerCase());
        out.set(id, Array.from(new Set([...ordered, ...local].filter(Boolean))));
      }
    } catch {
      for (const id of ids) {
        const local = this.presence.getClientsForUser(id).map((client) => String(client).trim().toLowerCase());
        out.set(id, Array.from(new Set(local.filter(Boolean))));
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
      const parsed = this.parseMember(member);
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
      await this.publish({ type: 'offline', userId: uid, instanceId: this.instanceId });
    }

    await this.sweepOfflineAnons();
  }
}

