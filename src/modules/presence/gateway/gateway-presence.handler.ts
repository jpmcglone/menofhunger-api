import { socketData } from './gateway-socket-data';
import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AppConfigService } from '../../app/app-config.service';
import { AuthService } from '../../auth/auth-public-api';
import { FollowsService } from '../../follows/follows.service';
import type { FollowListUser } from '../../follows/follows.service';
import { MarvinBotIdentityService } from '../../marvin/services/marvin-bot-identity.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis-keys';
import { SpacesPresenceService } from '../../spaces/spaces-presence.service';
import type { RadioChatSenderDto, SpaceChatSenderDto, SpaceLobbyCountsDto } from '../../../common/dto';
import { WsEventNames } from '../../../common/dto/realtime.dto';
import { parseSessionCookieFromHeader } from '../../../common/session-cookie';
import { sanitizeAnonViewerId } from '../../views/view-tracking.utils';
import { PresenceService } from '../presence.service';
import { PresenceAnonymousStateService } from '../presence-anonymous-state.service';
import { PresenceLobbyStateService } from '../presence-lobby-state.service';
import { PresenceRedisReadService } from '../presence-redis-read.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { GatewayContextService } from './gateway-context.service';
import { GatewayThrottleService } from './gateway-throttle.service';
import { AccountSwitchService } from '../../auth/auth-public-api';
import { CallSessionStore } from '../../calls/call-session.store';
import { canSeeMembers } from '../../auth/auth-public-api';
import { OnlineMembersService } from '../online-members.service';
import { SideEffectsService } from '../../side-effects/side-effects.service';

const COUNT_ONLY_UPDATE_DEBOUNCE_MS = 1500;

type UserTimers = {
  idleMarkTimer?: ReturnType<typeof setTimeout>;
  idleDisconnectTimer?: ReturnType<typeof setTimeout>;
};

/** Broadcast presence payloads cannot carry viewer-specific follow state. */
function withoutRelationship<T extends { relationship?: unknown }>(user: T): Omit<T, 'relationship'> {
  const { relationship: _ignored, ...rest } = user;
  return rest;
}

/**
 * Connection lifecycle + presence/status events: auth on connect, `client.data`
 * population, online/idle/active/offline fan-out, per-user idle timers, presence
 * subscriptions and the online feed snapshot.
 */
@Injectable()
export class PresenceStatusHandler {
  private readonly logger = new Logger(PresenceStatusHandler.name);
  private readonly userTimers = new Map<string, UserTimers>();
  /**
   * Bumped on every (re)connect; guards the async offline path so a reconnect
   * that lands while unregisterSocket is in flight doesn't emit a stale offline.
   */
  private readonly userPresenceNonce = new Map<string, number>();

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly presenceRead: PresenceRedisReadService,
    private readonly presenceAnon: PresenceAnonymousStateService,
    private readonly presenceLobby: PresenceLobbyStateService,
    private readonly follows: FollowsService,
    private readonly redis: RedisService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly throttle: GatewayThrottleService,
    private readonly context: GatewayContextService,
    private readonly accountSwitch: AccountSwitchService,
    private readonly callSessions: CallSessionStore,
    private readonly onlineMembers: OnlineMembersService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  // ─── Connection lifecycle ───────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    // Expose a promise that resolves once this async handler finishes.
    // Event handlers that need client.data.userId must await __ready first,
    // because Socket.IO dispatches events before handleConnection resolves.
    let resolveReady!: () => void;
    socketData(client).__ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    try {
      await this.handleConnectionInner(client);
    } finally {
      resolveReady();
    }
  }

  private async handleConnectionInner(client: Socket): Promise<void> {
    const cookieHeader = client.handshake.headers.cookie as string | undefined;
    const token = parseSessionCookieFromHeader(cookieHeader);
    let user: NonNullable<Awaited<ReturnType<AuthService['meFromSessionToken']>>>['user'] | null = null;
    // True when a site admin is driving this socket via impersonation. Such a socket must
    // still be registered (that's how `emitToUser` reaches it, so the admin sees live
    // updates), but it must not write activity to the target's account or announce them
    // as online — they are not actually here.
    let impersonated = false;
    try {
      const result = await this.auth.meFromSessionToken(token);
      user = result?.user ?? null;
      impersonated = Boolean(result?.impersonatedByUserId);
    } catch (err) {
      this.logger.warn(`[presence] Connection auth failed socket=${client.id}; continuing as anonymous: ${err}`);
    }

    const clientType =
      (Array.isArray(client.handshake.query.client)
        ? client.handshake.query.client[0]
        : client.handshake.query.client) ?? 'web';

    const userId = String(user?.id ?? '').trim() || null;
    const rawAnon =
      (Array.isArray(client.handshake.query.anon)
        ? client.handshake.query.anon[0]
        : client.handshake.query.anon) ?? '';
    const requestedAnonId = userId ? null : sanitizeAnonViewerId(String(rawAnon));
    // iOS is not browsable until login and never sends `anon`. Ignore it if a
    // stale or forged handshake includes one anyway.
    const anonId =
      requestedAnonId && String(clientType).toLowerCase() !== 'ios' ? requestedAnonId : null;
    let isNewlyOnline = false;
    let isNewlyAnonymous = false;
    if (userId) {
      this.cancelUserTimers(userId);
      this.userPresenceNonce.set(userId, (this.userPresenceNonce.get(userId) ?? 0) + 1);

      // Always register in-memory so emitToUser reaches this socket on this instance.
      this.presence.register(client.id, userId, String(clientType));
      if (!impersonated) {
        // Only write to Redis (online zset, socket set, pubsub) for real sessions.
        // An impersonated socket must not make the target user appear online to
        // other users or other API instances.
        const registration = await this.presenceRedis.registerSocket({
          socketId: client.id,
          userId,
          client: String(clientType),
        });
        isNewlyOnline = Boolean(registration?.isNewlyOnline);
        this.presence.persistLastSeenAt(userId);
        this.presence.persistDailyActivity(userId);
      }
    } else if (anonId) {
      const registration = await this.presenceAnon.registerAnonSocket({
        socketId: client.id,
        anonId,
        client: String(clientType),
      });
      isNewlyAnonymous = Boolean(registration?.isNewlyOnline);
    }

    socketData(client).userId = userId ?? undefined;
    socketData(client).anonId = anonId ?? undefined;
    socketData(client).presenceClient = String(clientType);
    socketData(client).impersonated = impersonated;
    socketData(client).viewer = {
      verified: Boolean(userId && user?.verifiedStatus && user.verifiedStatus !== 'none'),
      premium: Boolean(userId && user?.premium),
      premiumPlus: Boolean(userId && user?.premiumPlus),
      isOrganization: Boolean(userId && user?.isOrganization),
      verifiedStatus: ((userId ? user?.verifiedStatus : 'none') ?? 'none') as 'none' | 'identity' | 'manual',
      siteAdmin: Boolean(userId && user?.siteAdmin),
    };
    const chatUser = {
      id: userId ?? '',
      username: user?.username ?? null,
      premium: Boolean(userId && user?.premium),
      premiumPlus: Boolean(userId && user?.premiumPlus),
      isOrganization: Boolean(userId && user?.isOrganization),
      verifiedStatus: ((userId ? user?.verifiedStatus : 'none') ?? 'none') as 'none' | 'identity' | 'manual',
    } satisfies RadioChatSenderDto & SpaceChatSenderDto;
    socketData(client).radioChatUser = chatUser;
    socketData(client).spaceChatUser = chatUser;
    socketData(client).postSubs = new Set<string>();
    socketData(client).articleSubs = new Set<string>();
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] CONNECT socket=${client.id} userId=${userId ?? 'anon'} isNewlyOnline=${isNewlyOnline}`);
    }

    client.emit('presence:init', {});

    void (async () => {
      try {
        // Live aggregate — never seed from the Redis snapshot alone (it can linger
        // after lobbies empty and inflate the Spaces nav "(N)" count).
        const local = this.spacesPresence.getLobbyCountsBySpaceId();
        const countsBySpaceId = await this.presenceLobby.syncAndAggregateLobbyCounts(local);
        void this.redis
          .setJson(RedisKeys.spacesLobbyCounts(), countsBySpaceId, { ttlSeconds: 30 })
          .catch(() => undefined);
        client.emit('spaces:lobbyCounts', { countsBySpaceId } satisfies SpaceLobbyCountsDto);
      } catch {
        // best-effort
      }
    })();

    if (userId && !impersonated) {
      if (isNewlyOnline) {
        await this.emitOnline(userId);
        // Followers' "came online" pings are fan-out work: queued, throttled, never inline.
        this.sideEffects.dispatch('presence.followed-online', { userId });
      } else {
        await this.emitPlatformsChanged(userId);
      }
    }
    if (isNewlyAnonymous) {
      await this.emitAnonymousCount();
    }
    if (userId) {
      this.scheduleIdleMarkTimer(userId);
    }
  }

  /** Presence portion of disconnect: unregister, offline fan-out, timer cleanup. */
  handleDisconnect(client: Socket): void {
    const socketId = client.id;
    // Anonymous sockets never reach presence.unregister, so drop their feed subscription here.
    this.presence.unsubscribeOnlineFeed(socketId);
    let result: { userId?: string | null; isNowOffline?: boolean } | null = null;
    const hadUser = Boolean(socketData(client).userId);
    if (hadUser) {
      try {
        result = this.presence.unregister(socketId);
      } catch (err) {
        this.logger.warn(
          `[presence] disconnect unregister failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (this.context.logPresenceVerbose) {
      this.logger.debug(
        `[presence] DISCONNECT socket=${socketId} userId=${result?.userId ?? '?'} isNowOffline=${result?.isNowOffline ?? false}`,
      );
    }

    const anonId = String(socketData(client).anonId ?? '').trim();
    if (anonId) {
      void this.presenceAnon
        .unregisterAnonSocket({ socketId, anonId })
        .then(async (r) => {
          if (r?.isNowOffline) await this.emitAnonymousCount();
        })
        .catch(() => undefined);
    }

    const userId = String(result?.userId ?? '').trim();
    if (!userId) return;
    // Mirror of the connect path: an impersonated socket never wrote to Redis
    // (online zset, socket set), so there is nothing to unregister there and
    // no offline fan-out to emit.
    const impersonated = Boolean(socketData(client).impersonated);
    const nonceAtDisconnect = this.userPresenceNonce.get(userId) ?? 0;
    this.throttle.clearTypingThrottleForUser(userId);
    if (impersonated) return;
    void this.presenceRedis
      .unregisterSocket({ socketId, userId })
      .then(async (r) => {
        if (!r?.isNowOffline) {
          await this.emitPlatformsChanged(userId);
          return;
        }
        const currentNonce = this.userPresenceNonce.get(userId) ?? 0;
        if (currentNonce !== nonceAtDisconnect && this.presence.isUserOnline(userId)) return;
        try {
          this.cancelUserTimers(userId);
          this.presence.persistLastOnlineAt(userId);
          this.userPresenceNonce.delete(userId);
          await this.emitOffline(userId);
        } catch {
          // best-effort
        }
      })
      .catch(() => undefined);
  }

  // ─── Presence fan-out ───────────────────────────────────────────────

  private async onlineCounts(): Promise<{ totalOnline: number; anonymousOnline: number }> {
    const [roster, anonymousOnline] = await Promise.all([
      this.onlineMembers.resolve(),
      this.presenceRead.anonymousOnlineCount(),
    ]);
    return { totalOnline: roster.total, anonymousOnline };
  }

  private countOnlyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesces bursts of connects/disconnects into one count update for count-only listeners. */
  private scheduleCountOnlyUpdate(): void {
    if (this.countOnlyTimer || this.presence.getCountOnlyFeedListeners().size === 0) return;
    this.countOnlyTimer = setTimeout(() => {
      this.countOnlyTimer = null;
      const targets = this.presence.getCountOnlyFeedListeners();
      if (targets.size === 0) return;
      void this.onlineCounts()
        .then((counts) => this.context.emitToSockets(targets, WsEventNames.presenceOnlineCount, counts))
        .catch(() => undefined);
    }, COUNT_ONLY_UPDATE_DEBOUNCE_MS);
  }

  async emitAnonymousCount(anonymousOnline?: number): Promise<void> {
    this.scheduleCountOnlyUpdate();
    const targets = this.presence.getOnlineFeedListeners();
    if (targets.size === 0) return;
    const count =
      typeof anonymousOnline === 'number' && Number.isFinite(anonymousOnline)
        ? Math.max(0, Math.floor(anonymousOnline))
        : await this.presenceRead.anonymousOnlineCount();
    this.context.emitToSockets(targets, 'presence:anonymous-count', { anonymousOnline: count });
  }

  async emitOnline(userId: string): Promise<void> {
    this.scheduleCountOnlyUpdate();
    const cluster = await this.accountSwitch.presenceClusterByUserId([userId]);
    const displayedIds = cluster.get(userId) ?? [userId];
    for (const displayedId of displayedIds) {
      await this.emitOnlineOne(displayedId, userId);
    }
  }

  private async emitOnlineOne(userId: string, inheritFromUserId: string): Promise<void> {
    const allTargets = this.context.getTargetsForUser(userId);
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] emitOnline userId=${userId} totalTargets=${allTargets.size}`);
    }
    if (allTargets.size === 0) return;

    const sourceId = inheritFromUserId;
    const feedListeners = this.presence.getOnlineFeedListeners();
    let userPayload: FollowListUser | null = null;
    if (feedListeners.size > 0) {
      try {
        const users = await this.follows.getFollowListUsersByIds({
          viewerUserId: null,
          userIds: [userId],
        });
        userPayload = users[0] ? (withoutRelationship(users[0]) as FollowListUser) : null;
      } catch (err) {
        this.logger.warn(`Failed to fetch user ${userId} for presence:online: ${err}`);
      }
    }

    const [lastConnectAtById, idleById, platformsById] = await Promise.all([
      this.presenceRead.lastConnectAtMsByUserId([sourceId]),
      this.presenceRead.idleByUserIds([sourceId]),
      this.presenceRead.platformsByUserIds([sourceId]),
    ]);
    const lastConnectAt = lastConnectAtById.get(sourceId) ?? Date.now();
    const idle = idleById.get(sourceId) ?? this.presence.isUserIdle(sourceId);
    const platforms = platformsById.get(sourceId) ?? [];
    const status = userPayload ? await this.presence.getActiveStatusByUserId(userId) : null;
    const payload = userPayload
      ? { userId, user: { ...userPayload, status, platforms }, lastConnectAt, idle, platforms }
      : { userId, lastConnectAt, idle, platforms };
    this.context.emitToSockets(allTargets, 'presence:online', payload);
  }

  async emitPlatformsChanged(userId: string, authoritativePlatforms?: string[]): Promise<void> {
    const targets = this.presence.getOnlineFeedListeners();
    if (targets.size === 0) return;
    const platforms =
      authoritativePlatforms ?? (await this.presenceRead.platformsByUserIds([userId])).get(userId) ?? [];
    this.context.emitToSockets(targets, 'presence:platforms-changed', {
      userId,
      platforms,
    });
  }

  emitIdle(userId: string): void {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size > 0) {
      this.context.emitToSockets(targets, 'presence:idle', { userId });
    }
    void this.emitPresenceFlagToRestOfCluster(userId, 'presence:idle');
  }

  emitActive(userId: string): void {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size > 0) {
      this.context.emitToSockets(targets, 'presence:active', { userId });
    }
    void this.emitPresenceFlagToRestOfCluster(userId, 'presence:active');
  }

  private async emitPresenceFlagToRestOfCluster(
    sourceUserId: string,
    event: 'presence:idle' | 'presence:active',
  ): Promise<void> {
    const cluster = await this.accountSwitch.presenceClusterByUserId([sourceUserId]);
    for (const id of cluster.get(sourceUserId) ?? [sourceUserId]) {
      if (id === sourceUserId) continue;
      const targets = this.context.getTargetsForUser(id);
      if (targets.size === 0) continue;
      this.context.emitToSockets(targets, event, { userId: id });
    }
  }

  async emitOffline(userId: string): Promise<void> {
    const cluster = await this.accountSwitch.presenceClusterByUserId([userId]);
    const members = cluster.get(userId) ?? [userId];
    const onlineById = await this.presenceRead.onlineByUserIds(members);
    if ([...onlineById.values()].some(Boolean)) return;
    this.scheduleCountOnlyUpdate();
    for (const displayedId of members) {
      await this.emitOfflineOne(displayedId);
    }
  }

  private async emitOfflineOne(userId: string): Promise<void> {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size === 0) return;
    let user: FollowListUser | undefined;
    if (this.presence.getOnlineFeedListeners().size > 0) {
      const users = await this.follows
        .getFollowListUsersByIds({ viewerUserId: null, userIds: [userId] })
        .catch(() => []);
      user = users[0] ? (withoutRelationship(users[0]) as FollowListUser) : undefined;
    }
    this.context.emitToSockets(targets, 'presence:offline', {
      userId,
      user,
      lastOnlineAt: new Date().toISOString(),
    });
  }

  // ─── Event handlers ─────────────────────────────────────────────────

  async handleSubscribe(client: Socket, payload: { userIds?: string[] }): Promise<void> {
    // Presence subscriptions require an authenticated session.
    if (!socketData(client).userId) return;

    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] SUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    }
    if (userIds.length === 0) return;
    const { added } = this.presence.subscribe(client.id, userIds);
    if (added.length > 0) {
      const clusters = await this.accountSwitch.presenceClusterByUserId(added);
      const clusterIds = [...new Set(added.flatMap((uid) => clusters.get(uid) ?? [uid]))];
      const idleById = await this.presenceRead.idleByUserIds(clusterIds);
      const onlineById = await this.presenceRead.onlineByUserIds(clusterIds);
      const statusesById = new Map((await this.presence.getActiveStatuses(added)).map((status) => [status.userId, status]));
      const users = added.map((uid) => {
        const members = clusters.get(uid) ?? [uid];
        const connected = members.filter((id) => onlineById.get(id));
        const online = connected.length > 0;
        const idle = online && connected.every((id) => idleById.get(id) ?? false);
        const spaceId = this.spacesPresence.getSpaceForUser(uid) ?? undefined;
        const status = statusesById.get(uid) ?? null;
        return { userId: uid, online, idle, spaceId, status };
      });
      client.emit('presence:subscribed', { users });
    }
  }

  handleUnsubscribe(client: Socket, payload: { userIds?: string[] }): void {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] UNSUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    }
    if (userIds.length > 0) {
      this.presence.unsubscribe(client.id, userIds);
    }
  }

  async handleSubscribeOnlineFeed(client: Socket): Promise<void> {
    await (socketData(client).__ready)?.catch?.(() => undefined);
    const viewer = socketData(client).viewer;
    if (!canSeeMembers(viewer)) {
      this.presence.subscribeOnlineFeed(client.id, { countOnly: true });
      const counts = await this.onlineCounts();
      client.emit('presence:onlineFeedSnapshot', { users: [], ...counts, membersVisible: false });
      return;
    }
    this.presence.subscribeOnlineFeed(client.id);
    if (this.context.logPresenceVerbose) {
      this.logger.debug(
        `[presence] SUBSCRIBE_ONLINE_FEED_IN socket=${client.id} feedListeners=${this.presence.getOnlineFeedListeners().size}`,
      );
    }

    // The shared roster keeps this snapshot's total identical to REST and the map.
    const [roster, anonymousOnline] = await Promise.all([
      this.onlineMembers.resolve(),
      this.presenceRead.anonymousOnlineCount(),
    ]);
    const { connectedIds, memberIds: userIds, sourceByDisplayedId, marvId } = roster;
    // Per-client snapshot — include this socket's follow relationships so
    // /online does not paint "Follow" on people the viewer already follows.
    const viewerUserId = String(socketData(client).userId ?? '').trim() || null;
    if (roster.total === 0) {
      client.emit('presence:onlineFeedSnapshot', { users: [], totalOnline: 0, anonymousOnline, membersVisible: true });
      return;
    }
    try {
      const users = userIds.length
        ? await this.follows.getFollowListUsersByIds({
            viewerUserId,
            userIds,
          })
        : [];
      const [lastConnectAtById, idleById, platformsById, inCallIds] = await Promise.all([
        this.presenceRead.lastConnectAtMsByUserId(connectedIds),
        this.presenceRead.idleByUserIds(connectedIds),
        this.presenceRead.platformsByUserIds(connectedIds),
        this.callSessions.inCallByUserIds(userIds),
      ]);
      const statusesById = new Map((await this.presence.getActiveStatuses(userIds)).map((status) => [status.userId, status]));
      const payload: Array<FollowListUser & { lastConnectAt: number | null; idle: boolean; status: unknown; isBot?: boolean }> =
        users.map((u) => {
          const source = sourceByDisplayedId.get(u.id) ?? u.id;
          return {
            ...u,
            lastConnectAt: lastConnectAtById.get(u.id) ?? lastConnectAtById.get(source) ?? null,
            idle: idleById.get(u.id) ?? idleById.get(source) ?? false,
            status: statusesById.get(u.id) ?? null,
            platforms: platformsById.get(u.id) ?? platformsById.get(source) ?? [],
            inCall: inCallIds.has(u.id),
          };
        });

      // Pin Marv to the front of the snapshot (consistent with REST).
      const totalOnline = roster.total;
      if (marvId) {
        const [marvUser] = await this.follows.getFollowListUsersByIds({
          viewerUserId,
          userIds: [marvId],
        });
        if (marvUser) {
          payload.unshift({
            ...marvUser,
            lastConnectAt: Date.now(),
            idle: false,
            status: null,
            isBot: true,
          });
        }
      }

      client.emit('presence:onlineFeedSnapshot', { users: payload, totalOnline, anonymousOnline, membersVisible: true });
      if (this.context.logPresenceVerbose) {
        this.logger.debug(
          `[presence] EMIT_OUT presence:onlineFeedSnapshot to socket=${client.id} users=${payload.length}`,
        );
      }
    } catch (err) {
      this.logger.warn(`[presence] Failed to send onlineFeedSnapshot: ${err}`);
    }
  }

  handleUnsubscribeOnlineFeed(client: Socket): void {
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] UNSUBSCRIBE_ONLINE_FEED_IN socket=${client.id}`);
    }
    this.presence.unsubscribeOnlineFeed(client.id);
  }

  async handleLogout(client: Socket): Promise<void> {
    try {
      const cookieHeader = client.handshake.headers.cookie as string | undefined;
      const token = parseSessionCookieFromHeader(cookieHeader);
      await this.auth.revokeSessionToken(token);
    } catch (err) {
      this.logger.warn(`[presence] Failed to revoke session token on logout: ${err}`);
    }

    const result = this.presence.forceUnregister(client.id);
    if (result?.userId) {
      const userId = result.userId;
      const wasLastLocal = result.wasLastConnection;
      const r = await this.presenceRedis
        .unregisterSocket({ socketId: client.id, userId })
        .catch(() => ({ isNowOffline: wasLastLocal }));
      if (r.isNowOffline) {
        this.cancelUserTimers(userId);
        this.presence.persistLastOnlineAt(userId);
        await this.emitOffline(userId);
      } else {
        await this.emitPlatformsChanged(userId);
      }
    }
    try {
      client.disconnect(true);
    } catch {
      // ignore
    }
  }

  handleIdle(client: Socket): void {
    // Impersonated sockets never wrote to Redis, so idle/active state changes
    // for the target user must be ignored entirely.
    if (socketData(client).impersonated) return;
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setUserIdle(userId);
    void this.presenceRedis.setIdle(userId).catch(() => undefined);
    this.logger.log(`[presence] IDLE userId=${userId}`);
    this.emitIdle(userId);
  }

  handleActive(client: Socket): void {
    // Impersonated sockets must not update the target's last-seen / daily-activity
    // or flip their idle/active state — the admin's activity is not the user's.
    if (socketData(client).impersonated) return;
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setLastActivity(userId);
    const presenceClient = socketData(client).presenceClient ?? 'web';
    void this.presenceRedis.touchSocket({ socketId: client.id, userId, client: presenceClient }).catch(() => undefined);
    this.presence.persistLastSeenAt(userId);
    this.presence.persistDailyActivity(userId);
    const wasIdle = this.presence.isUserIdle(userId);
    this.presence.setUserActive(userId);
    void this.presenceRedis.setActive(userId).catch(() => undefined);
    this.scheduleIdleMarkTimer(userId);
    this.cancelIdleDisconnectTimer(userId);
    if (wasIdle) {
      this.logger.log(`[presence] ACTIVE userId=${userId}`);
      this.emitActive(userId);
    }
  }

  // ─── Timers ─────────────────────────────────────────────────────────

  private scheduleIdleMarkTimer(userId: string): void {
    this.cancelIdleMarkTimer(userId);
    const idleAfterMs = this.presence.presenceIdleAfterMinutes() * 60 * 1000;
    const idleMarkTimer = setTimeout(() => {
      this.userTimers.delete(userId);
      if (!this.presence.isUserOnline(userId)) return;
      const last = this.presence.getLastActivity(userId) ?? 0;
      if (Date.now() - last < idleAfterMs) return;
      this.presence.setUserIdle(userId);
      this.logger.log(`[presence] IDLE (no activity) userId=${userId}`);
      this.emitIdle(userId);
    }, idleAfterMs);
    const existing = this.userTimers.get(userId);
    this.userTimers.set(userId, { ...existing, idleMarkTimer });
  }

  private cancelUserTimers(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers) {
      if (timers.idleMarkTimer) clearTimeout(timers.idleMarkTimer);
      if (timers.idleDisconnectTimer) clearTimeout(timers.idleDisconnectTimer);
      this.userTimers.delete(userId);
    }
  }

  private cancelIdleMarkTimer(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers?.idleMarkTimer) {
      clearTimeout(timers.idleMarkTimer);
      const next = { ...timers, idleMarkTimer: undefined };
      if (next.idleDisconnectTimer) {
        this.userTimers.set(userId, next);
      } else {
        this.userTimers.delete(userId);
      }
    }
  }

  private cancelIdleDisconnectTimer(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers?.idleDisconnectTimer) {
      clearTimeout(timers.idleDisconnectTimer);
      const next = { ...timers, idleDisconnectTimer: undefined };
      if (next.idleMarkTimer) {
        this.userTimers.set(userId, next);
      } else {
        this.userTimers.delete(userId);
      }
    }
  }
}
