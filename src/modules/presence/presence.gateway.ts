import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, type Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { PresenceService } from './presence.service';
import { PresenceRealtimeService } from './presence-realtime.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import { AppConfigService } from '../app/app-config.service';
import { FollowsService } from '../follows/follows.service';
import type { FollowListUser } from '../follows/follows.service';
import { MessagesService } from '../messages/messages.service';
import { RadioService } from '../radio/radio.service';
import type { RadioListenerDto, RadioLobbyCountsDto } from '../../common/dto';
import { WsEventNames, type PostsSubscribePayloadDto } from '../../common/dto';
import { parseSessionCookieFromHeader } from '../../common/session-cookie';
import { PrismaService } from '../prisma/prisma.service';

type UserTimers = {
  idleMarkTimer?: ReturnType<typeof setTimeout>;
  idleDisconnectTimer?: ReturnType<typeof setTimeout>;
};

const MAX_POST_SUBSCRIPTIONS_PER_SOCKET = 60;
function postRoom(postId: string): string {
  return `post:${postId}`;
}

@WebSocketGateway({
  path: '/socket.io',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class PresenceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(PresenceGateway.name);
  // Performance: presence events can be very high-frequency. Never spam logs in production.
  private readonly logPresenceVerbose: boolean;
  private readonly userTimers = new Map<string, UserTimers>();
  private readonly typingThrottleByKey = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly realtime: PresenceRealtimeService,
    private readonly follows: FollowsService,
    private readonly messages: MessagesService,
    private readonly radio: RadioService,
    private readonly prisma: PrismaService,
  ) {
    this.logPresenceVerbose = !this.appConfig.isProd();
  }

  afterInit(server: Server): void {
    // Provide the Socket.IO server to other modules without them importing the gateway.
    this.realtime.setServer(server);

    // Cross-instance fanout: emit events from other instances to this instance's subscribers.
    const myInstanceId = this.presenceRedis.getInstanceId();
    this.presenceRedis.onEvent((evt) => {
      if (!evt?.userId) return;
      if ((evt as any).instanceId === myInstanceId) return;
      if (evt.type === 'online') this.emitOnline(evt.userId);
      else if (evt.type === 'offline') this.emitOffline(evt.userId);
      else if (evt.type === 'idle') this.emitIdle(evt.userId);
      else if (evt.type === 'active') this.emitActive(evt.userId);
      else if (evt.type === 'emitToUser') {
        const e = String((evt as any).event ?? '').trim();
        if (!e) return;
        this.presence.emitToUser(this.server, evt.userId, e, (evt as any).payload);
      } else if (evt.type === 'emitToRoom') {
        const room = String((evt as any).room ?? '').trim();
        const e = String((evt as any).event ?? '').trim();
        if (!room || !e) return;
        this.server.to(room).emit(e, (evt as any).payload);
      }
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const cookieHeader = client.handshake.headers.cookie as string | undefined;
    const token = parseSessionCookieFromHeader(cookieHeader);
    let user: any = null;
    try {
      user = await this.auth.meFromSessionToken(token);
    } catch (err) {
      this.logger.warn(`[presence] Connection auth failed socket=${client.id}: ${err}`);
      client.disconnect(true);
      return;
    }
    if (!user) {
      this.logger.debug(`Presence connection rejected: no session for socket ${client.id}`);
      client.disconnect(true);
      return;
    }

    this.cancelUserTimers(user.id);

    const clientType =
      (Array.isArray(client.handshake.query.client)
        ? client.handshake.query.client[0]
        : client.handshake.query.client) ?? 'web';

    // Local (per-instance) socket tracking for targeted emits.
    this.presence.register(client.id, user.id, String(clientType));
    // Global (cross-instance) presence state in Redis.
    const { isNewlyOnline } = await this.presenceRedis.registerSocket({
      socketId: client.id,
      userId: user.id,
      client: String(clientType),
    });
    // Best-effort: mark reading/being in-app as active for metrics (DAU/MAU).
    this.presence.persistLastSeenAt(user.id);
    this.presence.persistDailyActivity(user.id);
    // Store for downstream event handlers (radio, etc).
    (client.data as { userId?: string; presenceClient?: string }).userId = user.id;
    (client.data as { userId?: string; presenceClient?: string }).presenceClient = String(clientType);
    (client.data as any).viewer = {
      verified: Boolean(user?.verifiedStatus && user.verifiedStatus !== 'none'),
      premium: Boolean(user?.premium),
      premiumPlus: Boolean((user as any)?.premiumPlus),
      siteAdmin: Boolean((user as any)?.siteAdmin),
    };
    (client.data as any).postSubs = new Set<string>();
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] CONNECT socket=${client.id} userId=${user.id} isNewlyOnline=${isNewlyOnline}`);
    }

    client.emit('presence:init', {});

    if (isNewlyOnline) {
      await this.emitOnline(user.id);
    }
    this.scheduleIdleMarkTimer(user.id);
  }

  handleDisconnect(client: Socket): void {
    const result = this.presence.unregister(client.id);
    if (this.logPresenceVerbose) {
      this.logger.debug(
        `[presence] DISCONNECT socket=${client.id} userId=${result?.userId ?? '?'} isNowOffline=${result?.isNowOffline ?? false}`,
      );
    }
    if (result?.userId) {
      void this.presenceRedis
        .unregisterSocket({ socketId: client.id, userId: result.userId })
        .then((r) => {
          if (r.isNowOffline) {
            this.cancelUserTimers(result.userId);
            this.emitOffline(result.userId);
          }
        })
        .catch(() => undefined);
    }

    // Radio cleanup (best-effort).
    const radioLeft = this.radio.onDisconnect(client.id);
    if (radioLeft?.wasActive) {
      void this.emitRadioListeners(radioLeft.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  private async emitRadioListeners(stationId: string): Promise<void> {
    const sid = (stationId ?? '').trim();
    if (!sid) return;
    const { userIds, pausedUserIds, mutedUserIds } = this.radio.getListenersForStation(sid);
    const room = `radio:${sid}`;

    let listeners: RadioListenerDto[] = [];
    if (userIds.length > 0) {
      try {
        const users = await this.follows.getFollowListUsersByIds({ viewerUserId: null, userIds });
        const byId = new Map(users.map((u) => [u.id, u]));
        const pausedSet = new Set(pausedUserIds);
        const mutedSet = new Set(mutedUserIds);
        listeners = [];
        for (const id of userIds) {
          const u = byId.get(id);
          if (!u) continue;
          listeners.push({
            id: u.id,
            username: u.username,
            avatarUrl: u.avatarUrl ?? null,
            paused: pausedSet.has(u.id),
            muted: mutedSet.has(u.id),
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch radio listeners for station ${sid}: ${err}`);
      }
    }

    // Emit to everyone in the station room (including the joiner).
    this.server.to(room).emit('radio:listeners', { stationId: sid, listeners });
  }

  private emitRadioLobbyCounts(): void {
    const payload: RadioLobbyCountsDto = {
      countsByStationId: this.radio.getLobbyCountsByStationId(),
    };
    this.server.to('radio:lobbies').emit('radio:lobbyCounts', payload);
  }

  @SubscribeMessage('radio:join')
  async handleRadioJoin(
    client: Socket,
    payload: { stationId?: string },
  ): Promise<void> {
    const stationId = (payload?.stationId ?? '').trim();
    if (!this.radio.isValidStationId(stationId)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    // Update in-memory state (deduped per user) and track room subscription for this socket.
    const { prevStationId, prevRoomStationId } = this.radio.join({ socketId: client.id, userId, stationId });

    // Ensure this socket only receives updates for one station.
    if (prevRoomStationId && prevRoomStationId !== stationId) {
      client.leave(`radio:${prevRoomStationId}`);
    }
    client.join(`radio:${stationId}`);

    // If the user was previously listening to a different station, update that station's listeners.
    if (prevStationId && prevStationId !== stationId) {
      await this.emitRadioListeners(prevStationId);
    }
    await this.emitRadioListeners(stationId);
    this.emitRadioLobbyCounts();

    // Notify other tabs/windows for this user so they stop their radio (one play per user).
    const otherSocketIds = this.presence.getSocketIdsForUser(userId).filter((id) => id !== client.id);
    for (const sid of otherSocketIds) {
      this.server.sockets.sockets.get(sid)?.emit('radio:replaced', {});
    }
  }

  /**
   * Pause: stop counting as a listener, but remain subscribed to the room so the client can
   * still see live listener updates while paused.
   */
  @SubscribeMessage('radio:pause')
  async handleRadioPause(client: Socket): Promise<void> {
    const paused = this.radio.pause(client.id);
    if (paused?.wasActive && paused.changed) {
      await this.emitRadioListeners(paused.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  /**
   * Watch: subscribe to station updates without counting as a listener.
   */
  @SubscribeMessage('radio:watch')
  async handleRadioWatch(
    client: Socket,
    payload: { stationId?: string },
  ): Promise<void> {
    const stationId = (payload?.stationId ?? '').trim();
    if (!this.radio.isValidStationId(stationId)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const { prevRoomStationId } = this.radio.watch({ socketId: client.id, stationId });
    if (prevRoomStationId && prevRoomStationId !== stationId) {
      client.leave(`radio:${prevRoomStationId}`);
    }
    client.join(`radio:${stationId}`);

    // Ensure the watcher is not counted as a listener.
    const left = this.radio.leave(client.id);
    if (left?.wasActive) {
      await this.emitRadioListeners(left.stationId);
    }
    await this.emitRadioListeners(stationId);
    this.emitRadioLobbyCounts();
  }

  @SubscribeMessage('radio:leave')
  async handleRadioLeave(client: Socket): Promise<void> {
    const roomStationId = this.radio.getRoomStationForSocket(client.id);
    const left = this.radio.leave(client.id);
    this.radio.clearRoomForSocket(client.id);
    if (roomStationId) client.leave(`radio:${roomStationId}`);
    if (left?.wasActive) {
      await this.emitRadioListeners(left.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  @SubscribeMessage('radio:mute')
  async handleRadioMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    const muted = payload?.muted;
    if (typeof muted !== 'boolean') return;
    const res = this.radio.setMuted(client.id, muted);
    if (res?.wasActive && res.changed) {
      await this.emitRadioListeners(res.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  @SubscribeMessage('radio:lobbies:subscribe')
  handleRadioLobbiesSubscribe(client: Socket): void {
    client.join('radio:lobbies');
    const payload: RadioLobbyCountsDto = {
      countsByStationId: this.radio.getLobbyCountsByStationId(),
    };
    client.emit('radio:lobbyCounts', payload);
  }

  @SubscribeMessage('radio:lobbies:unsubscribe')
  handleRadioLobbiesUnsubscribe(client: Socket): void {
    client.leave('radio:lobbies');
  }

  private cancelUserTimers(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers) {
      if (timers.idleMarkTimer) clearTimeout(timers.idleMarkTimer);
      if (timers.idleDisconnectTimer) clearTimeout(timers.idleDisconnectTimer);
      this.userTimers.delete(userId);
    }
  }

  private getTargetsForUser(userId: string): Set<string> {
    return new Set([
      ...this.presence.getSubscribers(userId),
      ...this.presence.getOnlineFeedListeners(),
    ]);
  }

  private emitToSockets(socketIds: Iterable<string>, event: string, payload: unknown): void {
    const ids = [...socketIds];
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] EMIT_OUT event=${event} to ${ids.length} sockets`);
    }
    for (const id of ids) {
      const socket = this.server.sockets.sockets.get(id);
      socket?.emit(event, payload);
    }
  }

  private async emitOnline(userId: string): Promise<void> {
    const allTargets = this.getTargetsForUser(userId);
    if (this.logPresenceVerbose) {
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

    const lastConnectAt = this.presence.getLastConnectAt(userId) ?? Date.now();
    const idle = this.presence.isUserIdle(userId);
    const payload = userPayload
      ? { userId, user: userPayload, lastConnectAt, idle }
      : { userId, lastConnectAt, idle };
    this.emitToSockets(allTargets, 'presence:online', payload);
  }

  private emitIdle(userId: string): void {
    const targets = this.getTargetsForUser(userId);
    if (targets.size === 0) return;
    this.emitToSockets(targets, 'presence:idle', { userId });
  }

  private emitActive(userId: string): void {
    const targets = this.getTargetsForUser(userId);
    if (targets.size === 0) return;
    this.emitToSockets(targets, 'presence:active', { userId });
  }

  private emitOffline(userId: string): void {
    const targets = this.getTargetsForUser(userId);
    if (targets.size === 0) return;
    this.emitToSockets(targets, 'presence:offline', { userId });
  }

  @SubscribeMessage('presence:subscribe')
  async handleSubscribe(
    client: Socket,
    payload: { userIds?: string[] },
  ): Promise<void> {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] SUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    }
    if (userIds.length === 0) return;
    const { added } = this.presence.subscribe(client.id, userIds);
    if (added.length > 0) {
      const idleById = await this.presenceRedis.idleByUserIds(added);
      const onlineById = await this.presenceRedis.onlineByUserIds(added);
      const users = added.map((uid) => {
        const online = onlineById.get(uid) ?? false;
        const idle = online ? (idleById.get(uid) ?? false) : false;
        return { userId: uid, online, idle };
      });
      client.emit('presence:subscribed', { users });
    }
  }

  @SubscribeMessage('presence:unsubscribe')
  handleUnsubscribe(client: Socket, payload: { userIds?: string[] }): void {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] UNSUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    }
    if (userIds.length > 0) {
      this.presence.unsubscribe(client.id, userIds);
    }
  }

  @SubscribeMessage('posts:subscribe')
  async handlePostsSubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): Promise<void> {
    const raw = Array.isArray((payload as any)?.postIds) ? ((payload as any).postIds as unknown[]) : [];
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = (client.data as any).postSubs ?? new Set<string>();
    (client.data as any).postSubs = subs;
    const remainingCap = Math.max(0, MAX_POST_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    // Dedupe and enforce cap incrementally.
    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsVerified = Boolean(viewer?.siteAdmin) || Boolean(viewer?.verified);
    const viewerIsPremium = Boolean(viewer?.siteAdmin) || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    // Fetch minimal visibility fields for gating.
    const rows = await this.prisma.post.findMany({
      where: { id: { in: toConsider }, deletedAt: null },
      select: { id: true, userId: true, visibility: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const accepted: string[] = [];

    for (const postId of toConsider) {
      const row = byId.get(postId);
      if (!row) continue;
      const vis = String((row as any).visibility ?? '');
      const isSelf = Boolean(viewerId && row.userId === viewerId);
      if (vis === 'onlyMe' && !isSelf) continue;
      if (vis === 'verifiedOnly' && !viewerIsVerified && !isSelf) continue;
      if (vis === 'premiumOnly' && !viewerIsPremium && !isSelf) continue;

      subs.add(postId);
      accepted.push(postId);
      client.join(postRoom(postId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.postsSubscribed, { postIds: accepted });
    }
  }

  @SubscribeMessage('posts:unsubscribe')
  handlePostsUnsubscribe(client: Socket, payload: Partial<PostsSubscribePayloadDto>): void {
    const raw = Array.isArray((payload as any)?.postIds) ? ((payload as any).postIds as unknown[]) : [];
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = (client.data as any).postSubs ?? new Set<string>();
    for (const postId of ids) {
      subs.delete(postId);
      client.leave(postRoom(postId));
    }
    (client.data as any).postSubs = subs;
  }

  @SubscribeMessage('presence:subscribeOnlineFeed')
  async handleSubscribeOnlineFeed(client: Socket): Promise<void> {
    this.presence.subscribeOnlineFeed(client.id);
    if (this.logPresenceVerbose) {
      this.logger.debug(
        `[presence] SUBSCRIBE_ONLINE_FEED_IN socket=${client.id} feedListeners=${this.presence.getOnlineFeedListeners().size}`,
      );
    }

    // Send snapshot of currently online users to avoid race: User B connected before User A subscribed.
    const userIds = await this.presenceRedis.onlineUserIds();
    if (userIds.length === 0) return;
    try {
      const users = await this.follows.getFollowListUsersByIds({
        viewerUserId: null,
        userIds,
      });
      const lastConnectAtById = await this.presenceRedis.lastConnectAtMsByUserId(userIds);
      const idleById = await this.presenceRedis.idleByUserIds(userIds);
      const payload = users.map((u) => ({
        ...u,
        lastConnectAt: lastConnectAtById.get(u.id) ?? null,
        idle: idleById.get(u.id) ?? false,
      }));
      client.emit('presence:onlineFeedSnapshot', { users: payload, totalOnline: userIds.length });
      if (this.logPresenceVerbose) {
        this.logger.debug(`[presence] EMIT_OUT presence:onlineFeedSnapshot to socket=${client.id} users=${userIds.length}`);
      }
    } catch (err) {
      this.logger.warn(`[presence] Failed to send onlineFeedSnapshot: ${err}`);
    }
  }

  @SubscribeMessage('presence:unsubscribeOnlineFeed')
  handleUnsubscribeOnlineFeed(client: Socket): void {
    if (this.logPresenceVerbose) {
      this.logger.debug(`[presence] UNSUBSCRIBE_ONLINE_FEED_IN socket=${client.id}`);
    }
    this.presence.unsubscribeOnlineFeed(client.id);
  }

  @SubscribeMessage('messages:screen')
  handleMessagesScreen(
    client: Socket,
    payload: { active?: boolean },
  ): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const active = payload?.active !== false;
    this.presence.setChatScreenActive(client.id, active);
  }

  @SubscribeMessage('presence:logout')
  async handleLogout(client: Socket): Promise<void> {
    // Revoke the session server-side (best-effort), so socket-only logout can’t leave a valid session behind.
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
        this.emitOffline(userId);
      }
    }
    // Ensure the client reconnects cleanly after logout.
    try {
      client.disconnect(true);
    } catch {
      // ignore
    }
  }

  @SubscribeMessage('presence:idle')
  handleIdle(client: Socket): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setUserIdle(userId);
    void this.presenceRedis.setIdle(userId).catch(() => undefined);
    this.logger.log(`[presence] IDLE userId=${userId}`);
    this.emitIdle(userId);
    // Do not disconnect on idle; users stay connected.
  }

  /** Activity ping (fire-and-forget). Updates lastActivityAt and resets idle-mark timer. Clears idle if set. */
  @SubscribeMessage('presence:active')
  handleActive(client: Socket): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setLastActivity(userId);
    const presenceClient = (client.data as { presenceClient?: string } | undefined)?.presenceClient ?? 'web';
    void this.presenceRedis.touchSocket({ socketId: client.id, userId, client: presenceClient }).catch(() => undefined);
    // Best-effort: update metrics activity (server-throttled).
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

  /**
   * Realtime typing indicator for messages.
   * Client emits while typing; we fan-out to conversation participants (excluding sender).
   */
  @SubscribeMessage('messages:typing')
  async handleMessagesTyping(
    client: Socket,
    payload: { conversationId?: string; typing?: boolean },
  ): Promise<void> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const conversationId = String(payload?.conversationId ?? '').trim();
    if (!conversationId) return;
    const typing = payload?.typing !== false;

    // Throttle DB fanout: at most ~1 per 700ms per (user, conversation).
    const key = `${userId}:${conversationId}:${typing ? '1' : '0'}`;
    const now = Date.now();
    const last = this.typingThrottleByKey.get(key) ?? 0;
    if (now - last < 700) return;
    this.typingThrottleByKey.set(key, now);

    let participantIds: string[] = [];
    try {
      participantIds = await this.messages.listConversationParticipantUserIds({ userId, conversationId });
    } catch {
      // Not a participant or conversation missing; do not leak anything.
      return;
    }

    for (const id of participantIds) {
      if (!id || id === userId) continue;
      const targetSockets = this.presence.getChatScreenSocketIdsForUser(id);
      if (targetSockets.length === 0) continue;
      this.emitToSockets(targetSockets, 'messages:typing', {
        conversationId,
        userId,
        typing,
      });
    }
  }

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
      // Do not disconnect on idle; users stay connected.
    }, idleAfterMs);
    const existing = this.userTimers.get(userId);
    this.userTimers.set(userId, { ...existing, idleMarkTimer });
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

  private scheduleIdleDisconnectTimer(userId: string): void {
    this.cancelIdleDisconnectTimer(userId);
    const idleDisconnectMs = this.presence.idleDisconnectMs();
    const idleDisconnectTimer = setTimeout(() => {
      this.userTimers.delete(userId);
      if (!this.presence.isUserIdle(userId)) return;
      const socketIds = this.presence.getSocketIdsForUser(userId);
      this.logger.log(`[presence] IDLE_DISCONNECT userId=${userId} sockets=${socketIds.length}`);
      for (const socketId of socketIds) {
        const socket = this.server.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('presence:idleDisconnected', {});
        }
        this.presence.forceUnregister(socketId);
        socket?.disconnect(true);
      }
      this.emitOffline(userId);
    }, idleDisconnectMs);
    const existing = this.userTimers.get(userId);
    this.userTimers.set(userId, { ...existing, idleDisconnectTimer });
  }
}
