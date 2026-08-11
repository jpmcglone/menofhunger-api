import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AppConfigService } from '../../app/app-config.service';
import { AuthService } from '../../auth/auth.service';
import { FollowsService } from '../../follows/follows.service';
import type { FollowListUser } from '../../follows/follows.service';
import { MarvinBotIdentityService } from '../../marvin/services/marvin-bot-identity.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis-keys';
import { SpacesPresenceService } from '../../spaces/spaces-presence.service';
import type { RadioChatSenderDto, SpaceChatSenderDto, SpaceLobbyCountsDto } from '../../../common/dto';
import { parseSessionCookieFromHeader } from '../../../common/session-cookie';
import { PresenceService } from '../presence.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { GatewayContextService } from './gateway-context.service';
import { GatewayThrottleService } from './gateway-throttle.service';

type UserTimers = {
  idleMarkTimer?: ReturnType<typeof setTimeout>;
  idleDisconnectTimer?: ReturnType<typeof setTimeout>;
};

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
    private readonly follows: FollowsService,
    private readonly redis: RedisService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly marvIdentity: MarvinBotIdentityService,
    private readonly throttle: GatewayThrottleService,
    private readonly context: GatewayContextService,
  ) {}

  // ─── Connection lifecycle ───────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    // Expose a promise that resolves once this async handler finishes.
    // Event handlers that need client.data.userId must await __ready first,
    // because Socket.IO dispatches events before handleConnection resolves.
    let resolveReady!: () => void;
    (client.data as any).__ready = new Promise<void>((resolve) => {
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
    let user: any = null;
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
    let isNewlyOnline = false;
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
    }

    (client.data as { userId?: string; presenceClient?: string }).userId = userId ?? undefined;
    (client.data as { userId?: string; presenceClient?: string }).presenceClient = String(clientType);
    (client.data as { impersonated?: boolean }).impersonated = impersonated;
    (client.data as any).viewer = {
      verified: Boolean(userId && user?.verifiedStatus && user.verifiedStatus !== 'none'),
      premium: Boolean(userId && user?.premium),
      premiumPlus: Boolean(userId && (user as any)?.premiumPlus),
      isOrganization: Boolean(userId && (user as any)?.isOrganization),
      verifiedStatus: ((userId ? user?.verifiedStatus : 'none') ?? 'none') as 'none' | 'identity' | 'manual',
      stewardBadgeEnabled: Boolean(userId ? (user as any)?.stewardBadgeEnabled ?? true : true),
      siteAdmin: Boolean(userId && (user as any)?.siteAdmin),
    };
    (client.data as any).radioChatUser = {
      id: userId ?? '',
      username: (user?.username ?? null) as string | null,
      premium: Boolean(userId && user?.premium),
      premiumPlus: Boolean(userId && (user as any)?.premiumPlus),
      isOrganization: Boolean(userId && (user as any)?.isOrganization),
      verifiedStatus: ((userId ? user?.verifiedStatus : 'none') ?? 'none') as 'none' | 'identity' | 'manual',
      stewardBadgeEnabled: Boolean(userId ? (user as any)?.stewardBadgeEnabled ?? true : true),
    } satisfies RadioChatSenderDto;
    (client.data as any).spaceChatUser = (client.data as any).radioChatUser satisfies SpaceChatSenderDto;
    (client.data as any).postSubs = new Set<string>();
    (client.data as any).articleSubs = new Set<string>();
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] CONNECT socket=${client.id} userId=${userId ?? 'anon'} isNewlyOnline=${isNewlyOnline}`);
    }

    client.emit('presence:init', {});

    void (async () => {
      try {
        const cached = await this.redis.getJson<Record<string, number>>(RedisKeys.spacesLobbyCounts());
        const countsBySpaceId = cached ?? this.spacesPresence.getLobbyCountsBySpaceId();
        client.emit('spaces:lobbyCounts', { countsBySpaceId } satisfies SpaceLobbyCountsDto);
      } catch {
        // best-effort
      }
    })();

    if (userId && !impersonated) {
      if (isNewlyOnline) {
        await this.emitOnline(userId);
      } else {
        await this.emitPlatformsChanged(userId);
      }
    }
    if (userId) {
      this.scheduleIdleMarkTimer(userId);
    }
  }

  /** Presence portion of disconnect: unregister, offline fan-out, timer cleanup. */
  handleDisconnect(client: Socket): void {
    const socketId = client.id;
    let result: { userId?: string | null; isNowOffline?: boolean } | null = null;
    const hadUser = Boolean((client.data as { userId?: string }).userId);
    if (hadUser) {
      try {
        result = this.presence.unregister(socketId) as any;
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

    const userId = String(result?.userId ?? '').trim();
    if (!userId) return;
    // Mirror of the connect path: an impersonated socket never wrote to Redis
    // (online zset, socket set), so there is nothing to unregister there and
    // no offline fan-out to emit.
    const impersonated = Boolean((client.data as { impersonated?: boolean }).impersonated);
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

  async emitOnline(userId: string): Promise<void> {
    const allTargets = this.context.getTargetsForUser(userId);
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] emitOnline userId=${userId} totalTargets=${allTargets.size}`);
    }
    if (allTargets.size === 0) return;

    const feedListeners = this.presence.getOnlineFeedListeners();
    let userPayload: FollowListUser | null = null;
    if (feedListeners.size > 0) {
      try {
        const users = await this.follows.getFollowListUsersByIds({
          viewerUserId: null,
          userIds: [userId],
        });
        userPayload = users[0] ?? null;
      } catch (err) {
        this.logger.warn(`Failed to fetch user ${userId} for presence:online: ${err}`);
      }
    }

    const [lastConnectAtById, idleById, platformsById] = await Promise.all([
      this.presenceRedis.lastConnectAtMsByUserId([userId]),
      this.presenceRedis.idleByUserIds([userId]),
      this.presenceRedis.platformsByUserIds([userId]),
    ]);
    const lastConnectAt = lastConnectAtById.get(userId) ?? Date.now();
    const idle = idleById.get(userId) ?? this.presence.isUserIdle(userId);
    const platforms = platformsById.get(userId) ?? [];
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
      authoritativePlatforms ?? (await this.presenceRedis.platformsByUserIds([userId])).get(userId) ?? [];
    this.context.emitToSockets(targets, 'presence:platforms-changed', {
      userId,
      platforms,
    });
  }

  emitIdle(userId: string): void {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size === 0) return;
    this.context.emitToSockets(targets, 'presence:idle', { userId });
  }

  emitActive(userId: string): void {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size === 0) return;
    this.context.emitToSockets(targets, 'presence:active', { userId });
  }

  async emitOffline(userId: string): Promise<void> {
    const targets = this.context.getTargetsForUser(userId);
    if (targets.size === 0) return;
    let user: FollowListUser | undefined;
    if (this.presence.getOnlineFeedListeners().size > 0) {
      const users = await this.follows
        .getFollowListUsersByIds({ viewerUserId: null, userIds: [userId] })
        .catch(() => []);
      user = users[0];
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
    if (!(client.data as any).userId) return;

    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    if (this.context.logPresenceVerbose) {
      this.logger.debug(`[presence] SUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    }
    if (userIds.length === 0) return;
    const { added } = this.presence.subscribe(client.id, userIds);
    if (added.length > 0) {
      const idleById = await this.presenceRedis.idleByUserIds(added);
      const onlineById = await this.presenceRedis.onlineByUserIds(added);
      const statusesById = new Map((await this.presence.getActiveStatuses(added)).map((status) => [status.userId, status]));
      const users = added.map((uid) => {
        const online = onlineById.get(uid) ?? false;
        const idle = online ? (idleById.get(uid) ?? false) : false;
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
    this.presence.subscribeOnlineFeed(client.id);
    if (this.context.logPresenceVerbose) {
      this.logger.debug(
        `[presence] SUBSCRIBE_ONLINE_FEED_IN socket=${client.id} feedListeners=${this.presence.getOnlineFeedListeners().size}`,
      );
    }

    const userIds = await this.presenceRedis.onlineUserIds();
    // Resolve Marv pin (if enabled) once. We still emit a snapshot even when
    // there are no real online users, because Marv himself should appear as a
    // single-row snapshot when nobody else is connected.
    const marvId = this.appConfig.marvBot().enabled
      ? await this.marvIdentity.getMarvUserId().catch(() => null)
      : null;
    if (userIds.length === 0 && !marvId) return;
    try {
      const users = userIds.length
        ? await this.follows.getFollowListUsersByIds({
            viewerUserId: null,
            userIds,
          })
        : [];
      const [lastConnectAtById, idleById, platformsById] = await Promise.all([
        this.presenceRedis.lastConnectAtMsByUserId(userIds),
        this.presenceRedis.idleByUserIds(userIds),
        this.presenceRedis.platformsByUserIds(userIds),
      ]);
      const statusesById = new Map((await this.presence.getActiveStatuses(userIds)).map((status) => [status.userId, status]));
      const payload: Array<FollowListUser & { lastConnectAt: number | null; idle: boolean; status: unknown; isBot?: boolean }> =
        users.map((u) => ({
          ...u,
          lastConnectAt: lastConnectAtById.get(u.id) ?? null,
          idle: idleById.get(u.id) ?? false,
          status: statusesById.get(u.id) ?? null,
          platforms: platformsById.get(u.id) ?? [],
        }));

      // Pin Marv to the front of the snapshot (consistent with REST). The
      // viewer here is anonymous (snapshot is keyed only by the socket) so we
      // pass null and let the frontend's `isBot` sort handle ordering.
      let totalOnline = userIds.length;
      if (marvId) {
        const [marvUser] = await this.follows.getFollowListUsersByIds({
          viewerUserId: null,
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
          totalOnline += 1;
        }
      }

      client.emit('presence:onlineFeedSnapshot', { users: payload, totalOnline });
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
    if ((client.data as any).impersonated) return;
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
    if ((client.data as any).impersonated) return;
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setLastActivity(userId);
    const presenceClient = (client.data as { presenceClient?: string } | undefined)?.presenceClient ?? 'web';
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
