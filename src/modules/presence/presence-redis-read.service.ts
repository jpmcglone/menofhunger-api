import { Injectable } from '@nestjs/common';
import { RedisKeys } from '../redis/redis-keys';
import { RedisService } from '../redis/redis.service';
import { PresenceRedisBusService } from './presence-redis-bus.service';
import { parseSocketMember } from './presence-socket-member';
import { PresenceService } from './presence.service';

/** Cross-instance presence reads: who is online/idle, on which platforms, and which sockets are provably live. */
@Injectable()
export class PresenceRedisReadService {
  constructor(
    private readonly redis: RedisService,
    private readonly bus: PresenceRedisBusService,
    private readonly presence: PresenceService,
  ) {}

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
    const refs = members.map((m) => parseSocketMember(m)).filter((r): r is { instanceId: string; socketId: string } => r !== null);
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
      const scores = await this.redis.raw().zmscore(RedisKeys.presenceOnlineZset(), ...ids);
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
          const parsed = parseSocketMember(member);
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
      const parsed = parseSocketMember(m);
      if (parsed?.instanceId !== this.bus.getInstanceId()) continue;
      ids.push(parsed.socketId);
    }
    return ids;
  }

  async anonymousOnlineCount(): Promise<number> {
    try {
      const n = await this.redis.raw().zcard(RedisKeys.presenceAnonOnlineZset());
      return Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
    } catch {
      return 0;
    }
  }
}
