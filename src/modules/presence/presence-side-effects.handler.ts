import { AccountSwitchService } from '../auth/auth-public-api';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import { FANOUT_CONCURRENCY, runInBatches } from '../side-effects/batch';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { SideEffectsService } from '../side-effects/side-effects.service';
import { toUserListDto } from '../../common/dto';
import { NOT_BANNED_USER_WHERE } from '../../common/prisma-selects/user.where';
import { USER_LIST_SELECT } from '../../common/prisma-selects/user.select';
import { PresenceRealtimeService } from './presence-realtime.service';
import { PresenceRedisReadService } from './presence-redis-read.service';

/** A reconnect after less time than this is a blip, not "came online". */
export const FOLLOW_ONLINE_MIN_OFFLINE_MS = 15 * 60_000;
/** Tell a viewer about the same person at most this often. */
export const FOLLOW_ONLINE_PER_PERSON_SECONDS = 2 * 60 * 60;
/** At most one ping per viewer in this window; later arrivals are batched into one. */
export const FOLLOW_ONLINE_QUIET_MS = 5 * 60_000;
const PENDING_TTL_SECONDS = 15 * 60;
const MAX_USERS_PER_PING = 3;

/**
 * "Someone you follow came online" in-app pings (web toast, iOS banner; never push).
 *
 * Only online followers are told, only when the person was really away (15+ minutes), at most
 * once per person per 2 hours, and at most one ping per viewer every 5 minutes; anyone else
 * arriving in that window rides along in a single batched ping when it ends.
 */
@Injectable()
export class PresenceSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
    private readonly presenceRedis: PresenceRedisReadService,
    private readonly realtime: PresenceRealtimeService,
    private readonly registry: SideEffectsRegistry,
    private readonly sideEffects: SideEffectsService,
    private readonly accountSwitch: AccountSwitchService,
  ) {}

  onModuleInit(): void {
    this.registry.register('presence.followed-online', (p) => this.onFollowedOnline(p));
    this.registry.register('presence.followed-online.flush', (p) => this.onFlush(p));
    this.registry.register('presence.followed-offline', (p) => this.onFollowedOffline(p));
  }

  async onFollowedOnline({ userId }: SideEffectPayloads['presence.followed-online']): Promise<void> {
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { usernameIsSet: true, bannedAt: true, isBot: true, accountKind: true, lastOnlineAt: true },
    });
    if (!person?.usernameIsSet || person.bannedAt || person.isBot || person.accountKind === 'page') return;
    // `lastOnlineAt` is written when their last socket closed, so it is when they went away.
    if (person.lastOnlineAt && Date.now() - person.lastOnlineAt.getTime() < FOLLOW_ONLINE_MIN_OFFLINE_MS) return;

    const onlineIds = await this.presenceRedis.onlineUserIds();
    if (!onlineIds.includes(userId)) return;
    const viewers = await this.eligibleViewers(userId, onlineIds.filter((id) => id !== userId));

    await runInBatches(viewers, FANOUT_CONCURRENCY, async (viewerUserId) => {
      const fresh = await this.redis.setString(RedisKeys.followOnlinePair(viewerUserId, userId), '1', {
        ttlSeconds: FOLLOW_ONLINE_PER_PERSON_SECONDS,
        onlyIfAbsent: true,
      });
      if (!fresh) return;

      const now = Date.now();
      const opened = await this.redis.setString(RedisKeys.followOnlineRecent(viewerUserId), String(now), {
        ttlMs: FOLLOW_ONLINE_QUIET_MS,
        onlyIfAbsent: true,
      });
      if (opened) {
        await this.send(viewerUserId, [userId]);
        return;
      }

      const pendingKey = RedisKeys.followOnlinePending(viewerUserId);
      const pending = (await this.redis.getJson<string[]>(pendingKey)) ?? [];
      if (!pending.includes(userId)) pending.push(userId);
      await this.redis.setJson(pendingKey, pending, { ttlSeconds: PENDING_TTL_SECONDS });
      const since = Number(await this.redis.getString(RedisKeys.followOnlineRecent(viewerUserId))) || now;
      this.sideEffects.dispatch(
        'presence.followed-online.flush',
        { viewerUserId },
        { jobId: `follow-online-flush:${viewerUserId}:${since}`, delay: Math.max(1000, since + FOLLOW_ONLINE_QUIET_MS - now) },
      );
    });
  }

  async onFlush({ viewerUserId }: SideEffectPayloads['presence.followed-online.flush']): Promise<void> {
    const pendingKey = RedisKeys.followOnlinePending(viewerUserId);
    const pending = (await this.redis.getJson<string[]>(pendingKey)) ?? [];
    await this.redis.del(pendingKey);
    if (pending.length === 0) return;
    const onlineIds = new Set(await this.presenceRedis.onlineUserIds());
    if (!onlineIds.has(viewerUserId)) return;
    const stillOnline = pending.filter((id) => onlineIds.has(id));
    if (stillOnline.length === 0) return;
    await this.redis.setString(RedisKeys.followOnlineRecent(viewerUserId), String(Date.now()), {
      ttlMs: FOLLOW_ONLINE_QUIET_MS,
    });
    await this.send(viewerUserId, stillOnline);
  }

  /** A disconnect is only a heads-up after 30 seconds without reconnecting. */
  async onFollowedOffline({ userId, offlineAt, epoch }: SideEffectPayloads['presence.followed-offline']): Promise<void> {
    const age = Date.now() - offlineAt;
    if (!Number.isFinite(age) || age < 30_000 || age > 5 * 60_000
      || await this.redis.getString(RedisKeys.followOfflineEpoch(userId)) !== epoch) return;
    const onlineIds = await this.presenceRedis.onlineUserIds();
    if (!(await this.isOffline(userId, onlineIds))) return;
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { usernameIsSet: true, bannedAt: true, isBot: true, accountKind: true, lastOnlineAt: true },
    });
    if (!person?.usernameIsSet || person.bannedAt || person.isBot || person.accountKind === 'page') return;
    // The epoch is stamped again for every displayed identity on a later disconnect.
    const viewers = await this.eligibleViewers(userId, onlineIds.filter(id => id !== userId));
    await runInBatches(viewers, FANOUT_CONCURRENCY, async viewerUserId => {
      const fresh = await this.redis.setString(RedisKeys.followOfflinePair(viewerUserId, userId), '1', {
        ttlSeconds: FOLLOW_ONLINE_PER_PERSON_SECONDS, onlyIfAbsent: true,
      });
      if (!fresh) return;
      // Offline moments are intentionally sparse: one per viewer every five minutes.
      const opened = await this.redis.setString(RedisKeys.followOfflineRecent(viewerUserId), '1', {
        ttlMs: FOLLOW_ONLINE_QUIET_MS, onlyIfAbsent: true,
      });
      if (!opened) return;
      // Recheck membership/preferences and presence after asynchronous eligibility work.
      const currentOnline = await this.presenceRedis.onlineUserIds();
      if (!(await this.isOffline(userId, currentOnline)) || !currentOnline.includes(viewerUserId)
        || !(await this.eligibleViewers(userId, [viewerUserId])).includes(viewerUserId)) return;
      const rows = await this.prisma.user.findMany({ where: { id: { in: [userId] }, ...NOT_BANNED_USER_WHERE }, select: USER_LIST_SELECT });
      const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
      const users = rows.filter(row => !row.isBot && row.accountKind !== 'page').map(row => toUserListDto(row, baseUrl));
      if (!(await this.isOffline(userId, await this.presenceRedis.onlineUserIds()))
        || await this.redis.getString(RedisKeys.followOfflineEpoch(userId)) !== epoch) return;
      if (users.length) this.realtime.emitFollowedOffline(viewerUserId, { users: users.slice(0, 1), total: 1 });
    });
  }

  private async isOffline(userId: string, onlineIds: string[]): Promise<boolean> {
    const clusters = await this.accountSwitch.presenceClusterByUserId([userId]);
    return !(clusters.get(userId) ?? [userId]).some(id => onlineIds.includes(id));
  }

  /** Online followers who want these pings and haven't muted or blocked (either way) the person. */
  private async eligibleViewers(userId: string, onlineIds: string[]): Promise<string[]> {
    if (onlineIds.length === 0) return [];
    const followers = await this.prisma.follow.findMany({
      where: { followingId: userId, followerId: { in: onlineIds } },
      select: { followerId: true },
    });
    const candidateIds = followers.map((f) => f.followerId);
    if (candidateIds.length === 0) return [];
    const [optedOut, mutes, blocks] = await Promise.all([
      this.prisma.notificationPreferences.findMany({
        where: { userId: { in: candidateIds }, inAppFollowOnline: false },
        select: { userId: true },
      }),
      this.prisma.userMute.findMany({
        where: { mutedId: userId, muterId: { in: candidateIds } },
        select: { muterId: true },
      }),
      this.prisma.userBlock.findMany({
        where: {
          OR: [
            { blockerId: userId, blockedId: { in: candidateIds } },
            { blockedId: userId, blockerId: { in: candidateIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
    ]);
    const excluded = new Set<string>([
      ...optedOut.map((p) => p.userId),
      ...mutes.map((m) => m.muterId),
      ...blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)),
    ]);
    return candidateIds.filter((id) => !excluded.has(id));
  }

  private async send(viewerUserId: string, userIds: string[]): Promise<void> {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds.slice(0, MAX_USERS_PER_PING) } },
      select: USER_LIST_SELECT,
    });
    const order = new Map(userIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const baseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const users = rows.map((r) => toUserListDto(r, baseUrl));
    if (users.length === 0) return;
    this.realtime.emitFollowedOnline(viewerUserId, { users, total: userIds.length });
  }
}
