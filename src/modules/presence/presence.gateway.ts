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
import { RadioChatService } from '../radio/radio-chat.service';
import { RadioService } from '../radio/radio.service';
import { SpacesChatService } from '../spaces/spaces-chat.service';
import { SpacesPresenceService } from '../spaces/spaces-presence.service';
import { SpacesService } from '../spaces/spaces.service';
import type {
  RadioChatSenderDto,
  RadioListenerDto,
  RadioLobbyCountsDto,
  SpaceChatSenderDto,
  SpaceListenerDto,
  SpaceLobbyCountsDto,
} from '../../common/dto';
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
function radioChatRoom(stationId: string): string {
  return `radioChat:${stationId}`;
}
function spaceRoom(spaceId: string): string {
  return `space:${spaceId}`;
}
function spacesChatRoom(spaceId: string): string {
  return `spacesChat:${spaceId}`;
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
  private readonly reactionThrottleByKey = new Map<string, number>();
  private typingThrottleLastPruneAtMs = 0;
  private readonly typingThrottlePruneEveryMs = 10_000;
  private readonly typingThrottleEntryTtlMs = 1000 * 60 * 2;
  private readonly userPresenceNonce = new Map<string, number>();

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
    private readonly radioChat: RadioChatService,
    private readonly spaces: SpacesService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly spacesChat: SpacesChatService,
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

  private maybePruneTypingThrottle(nowMs: number): void {
    if (nowMs - this.typingThrottleLastPruneAtMs < this.typingThrottlePruneEveryMs) return;
    this.typingThrottleLastPruneAtMs = nowMs;
    const minMs = nowMs - this.typingThrottleEntryTtlMs;
    for (const [k, lastAt] of this.typingThrottleByKey.entries()) {
      if (lastAt < minMs) this.typingThrottleByKey.delete(k);
    }
  }

  private clearTypingThrottleForUser(userIdRaw: string): void {
    const userId = String(userIdRaw ?? '').trim();
    if (!userId) return;
    const spacesPrefix = `spaces:${userId}:`;
    const msgPrefix = `${userId}:`;
    for (const k of this.typingThrottleByKey.keys()) {
      if (k.startsWith(spacesPrefix) || k.startsWith(msgPrefix)) {
        this.typingThrottleByKey.delete(k);
      }
    }
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
    this.userPresenceNonce.set(String(user.id), (this.userPresenceNonce.get(String(user.id)) ?? 0) + 1);

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
      isOrganization: Boolean((user as any)?.isOrganization),
      verifiedStatus: (user?.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
      stewardBadgeEnabled: Boolean((user as any)?.stewardBadgeEnabled ?? true),
      siteAdmin: Boolean((user as any)?.siteAdmin),
    };
    (client.data as any).radioChatUser = {
      id: String(user?.id ?? '').trim(),
      username: (user?.username ?? null) as string | null,
      premium: Boolean(user?.premium),
      premiumPlus: Boolean((user as any)?.premiumPlus),
      isOrganization: Boolean((user as any)?.isOrganization),
      verifiedStatus: (user?.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
      stewardBadgeEnabled: Boolean((user as any)?.stewardBadgeEnabled ?? true),
    } satisfies RadioChatSenderDto;
    // Spaces chat sender is the same shape; keep both keys for a smooth transition.
    (client.data as any).spaceChatUser = (client.data as any).radioChatUser satisfies SpaceChatSenderDto;
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
    const socketId = client.id;
    let result: { userId?: string | null; isNowOffline?: boolean } | null = null;
    try {
      result = this.presence.unregister(socketId) as any;
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect unregister failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (this.logPresenceVerbose) {
      this.logger.debug(
        `[presence] DISCONNECT socket=${socketId} userId=${result?.userId ?? '?'} isNowOffline=${result?.isNowOffline ?? false}`,
      );
    }

    const userId = String(result?.userId ?? '').trim();
    if (userId) {
      const nonceAtDisconnect = this.userPresenceNonce.get(userId) ?? 0;
      this.clearTypingThrottleForUser(userId);
      void this.presenceRedis
        .unregisterSocket({ socketId, userId })
        .then((r) => {
          if (!r?.isNowOffline) return;
          const currentNonce = this.userPresenceNonce.get(userId) ?? 0;
          if (currentNonce !== nonceAtDisconnect && this.presence.isUserOnline(userId)) return;
          try {
            this.cancelUserTimers(userId);
            this.presence.persistLastOnlineAt(userId);
            this.emitOffline(userId);
          } catch {
            // best-effort
          }
        })
        .catch(() => undefined);
    }

    // Radio cleanup (best-effort).
    try {
      const radioLeft = this.radio.onDisconnect(socketId);
      if (radioLeft?.wasActive) {
        void this.emitRadioListeners(radioLeft.stationId);
        this.emitRadioLobbyCounts();
      }
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect radio cleanup failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Spaces cleanup (best-effort).
    try {
      const spaceLeft = this.spacesPresence.onDisconnect(socketId);
      if (spaceLeft?.wasActive) {
        void this.emitSpaceMembers(spaceLeft.spaceId);
        this.emitSpacesLobbyCounts();
      }
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect spaces cleanup failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
            premium: u.premium ?? false,
            premiumPlus: u.premiumPlus ?? false,
            isOrganization: u.isOrganization ?? false,
            verifiedStatus: (u.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
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

  private async emitSpaceMembers(spaceId: string): Promise<void> {
    const sid = (spaceId ?? '').trim();
    if (!sid) return;
    const { userIds, pausedUserIds, mutedUserIds } = this.spacesPresence.getMembersForSpace(sid);
    const room = spaceRoom(sid);

    let listeners: SpaceListenerDto[] = [];
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
            premium: u.premium ?? false,
            premiumPlus: u.premiumPlus ?? false,
            isOrganization: u.isOrganization ?? false,
            verifiedStatus: (u.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
            paused: pausedSet.has(u.id),
            muted: mutedSet.has(u.id),
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch space members for space ${sid}: ${err}`);
      }
    }

    this.server.to(room).emit('spaces:members', { spaceId: sid, members: listeners });
  }

  private emitSpacesLobbyCounts(): void {
    const payload: SpaceLobbyCountsDto = {
      countsBySpaceId: this.spacesPresence.getLobbyCountsBySpaceId(),
    };
    this.server.to('spaces:lobbies').emit('spaces:lobbyCounts', payload);
  }

  @SubscribeMessage('spaces:join')
  async handleSpacesJoin(client: Socket, payload: { spaceId?: string }): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const { prevSpaceId, prevRoomSpaceId } = this.spacesPresence.join({ socketId: client.id, userId, spaceId });
    if (prevRoomSpaceId && prevRoomSpaceId !== spaceId) {
      client.leave(spaceRoom(prevRoomSpaceId));
    }
    client.join(spaceRoom(spaceId));

    // Keep legacy radio presence in sync while we transition (space may have no station).
    const stationId = this.spaces.getStationIdBySpaceId(spaceId);
    if (stationId && this.radio.isValidStationId(stationId)) {
      const { prevStationId, prevRoomStationId } = this.radio.join({ socketId: client.id, userId, stationId });
      if (prevRoomStationId && prevRoomStationId !== stationId) client.leave(`radio:${prevRoomStationId}`);
      client.join(`radio:${stationId}`);
      if (prevStationId && prevStationId !== stationId) await this.emitRadioListeners(prevStationId);
      await this.emitRadioListeners(stationId);
      this.emitRadioLobbyCounts();
    }

    if (prevSpaceId && prevSpaceId !== spaceId) {
      await this.emitSpaceMembers(prevSpaceId);
    }
    await this.emitSpaceMembers(spaceId);
    this.emitSpacesLobbyCounts();
  }

  @SubscribeMessage('spaces:leave')
  async handleSpacesLeave(client: Socket): Promise<void> {
    const roomSpaceId = this.spacesPresence.getRoomSpaceForSocket(client.id);
    const left = this.spacesPresence.leave(client.id);
    this.spacesPresence.clearRoomForSocket(client.id);
    if (roomSpaceId) client.leave(spaceRoom(roomSpaceId));
    if (left?.wasActive) {
      await this.emitSpaceMembers(left.spaceId);
      this.emitSpacesLobbyCounts();
    }

    // Best-effort legacy cleanup.
    const radioRoomStationId = this.radio.getRoomStationForSocket(client.id);
    const radioLeft = this.radio.leave(client.id);
    this.radio.clearRoomForSocket(client.id);
    if (radioRoomStationId) client.leave(`radio:${radioRoomStationId}`);
    if (radioLeft?.wasActive) {
      await this.emitRadioListeners(radioLeft.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  @SubscribeMessage('spaces:pause')
  async handleSpacesPause(client: Socket): Promise<void> {
    const paused = this.spacesPresence.pause(client.id);
    if (paused?.wasActive && paused.changed) {
      await this.emitSpaceMembers(paused.spaceId);
      this.emitSpacesLobbyCounts();
    }
  }

  @SubscribeMessage('spaces:mute')
  async handleSpacesMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    const muted = payload?.muted;
    if (typeof muted !== 'boolean') return;
    const res = this.spacesPresence.setMuted(client.id, muted);
    if (res?.wasActive && res.changed) {
      await this.emitSpaceMembers(res.spaceId);
      this.emitSpacesLobbyCounts();
    }
  }

  @SubscribeMessage('spaces:lobbies:subscribe')
  handleSpacesLobbiesSubscribe(client: Socket): void {
    client.join('spaces:lobbies');
    const payload: SpaceLobbyCountsDto = {
      countsBySpaceId: this.spacesPresence.getLobbyCountsBySpaceId(),
    };
    client.emit('spaces:lobbyCounts', payload);
  }

  @SubscribeMessage('spaces:lobbies:unsubscribe')
  handleSpacesLobbiesUnsubscribe(client: Socket): void {
    client.leave('spaces:lobbies');
  }

  @SubscribeMessage('spaces:chatSubscribe')
  handleSpacesChatSubscribe(client: Socket, payload: { spaceId?: string }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const prev = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
    if (prev && prev !== spaceId) {
      client.leave(spacesChatRoom(prev));
    }

    (client.data as any).spaceChatSpaceId = spaceId;
    client.join(spacesChatRoom(spaceId));
    client.emit('spaces:chatSnapshot', this.spacesChat.snapshot(spaceId));

    // System message (live-only): joining chat.
    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    const joinMsg = sender?.id
      ? this.spacesChat.appendSystemMessage({
          spaceId,
          event: 'join',
          userId: sender.id,
          username: sender.username ?? null,
        })
      : null;
    if (joinMsg) {
      const room = spacesChatRoom(spaceId);
      const out = { spaceId, message: joinMsg };
      this.server.to(room).emit('spaces:chatMessage', out);
      void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
    }

    // Legacy: if this space has a station, keep old room subscription too.
    const stationId = this.spaces.getStationIdBySpaceId(spaceId);
    if (stationId && this.radio.isValidStationId(stationId)) {
      (client.data as any).radioChatStationId = stationId;
      client.join(radioChatRoom(stationId));
      // Snapshot for legacy clients (sent only if they subscribed via radio:*).
    }
  }

  @SubscribeMessage('spaces:chatUnsubscribe')
  handleSpacesChatUnsubscribe(client: Socket): void {
    const prev = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
    if (prev) {
      // System message (live-only): leaving chat. Emit before removing socket so the leaver sees it.
      const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
      const leftMsg = sender?.id
        ? this.spacesChat.appendSystemMessage({
            spaceId: prev,
            event: 'leave',
            userId: sender.id,
            username: sender.username ?? null,
          })
        : null;
      if (leftMsg) {
        const room = spacesChatRoom(prev);
        const out = { spaceId: prev, message: leftMsg };
        this.server.to(room).emit('spaces:chatMessage', out);
        void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
      }
      client.leave(spacesChatRoom(prev));
    }
    (client.data as any).spaceChatSpaceId = null;
  }

  @SubscribeMessage('spaces:chatSend')
  handleSpacesChatSend(client: Socket, payload: { spaceId?: string; body?: string }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    const body = String(payload?.body ?? '');
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const subscribed = String((client.data as any)?.spaceChatSpaceId ?? '').trim();
    if (!subscribed || subscribed !== spaceId) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    if (!this.spacesChat.canSend(userId)) return;

    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    if (!sender?.id) return;

    const msg = this.spacesChat.appendMessage({ spaceId, sender, body });
    if (!msg) return;

    const room = spacesChatRoom(spaceId);
    const out = { spaceId, message: msg };
    this.server.to(room).emit('spaces:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);

    // Back-compat emit to radio room when the space has a station attached.
    const stationId = this.spaces.getStationIdBySpaceId(spaceId);
    if (stationId && this.radio.isValidStationId(stationId)) {
      const radioRoom = radioChatRoom(stationId);
      const radioOut = {
        stationId,
        message: {
          id: msg.id,
          stationId,
          body: msg.body,
          createdAt: msg.createdAt,
          sender: msg.sender,
        },
      };
      this.server.to(radioRoom).emit('radio:chatMessage', radioOut);
      void this.presenceRedis.publishEmitToRoom({ room: radioRoom, event: 'radio:chatMessage', payload: radioOut }).catch(() => undefined);
    }
  }

  @SubscribeMessage('spaces:reaction')
  handleSpacesReaction(client: Socket, payload: { spaceId?: string; reactionId?: string }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    const reactionId = String(payload?.reactionId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const reaction = this.spaces.getReactionById(reactionId);
    if (!reaction) return;

    // Throttle: at most ~1 per 400ms per user.
    const key = `spaces:reaction:${userId}`;
    const now = Date.now();
    const last = this.reactionThrottleByKey.get(key) ?? 0;
    if (now - last < 400) return;
    this.reactionThrottleByKey.set(key, now);

    const room = spaceRoom(spaceId);
    const out = { spaceId, userId, reactionId: reaction.id, emoji: reaction.emoji };
    this.server.to(room).emit('spaces:reaction', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:reaction', payload: out }).catch(() => undefined);
  }

  /**
   * Realtime typing indicator for Spaces live chat.
   * Client emits while typing; we fan-out to other sockets in the space chat room.
   */
  @SubscribeMessage('spaces:typing')
  handleSpacesTyping(client: Socket, payload: { spaceId?: string; typing?: boolean }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const subscribed = String((client.data as any)?.spaceChatSpaceId ?? '').trim();
    if (!subscribed || subscribed !== spaceId) return;

    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    if (!sender?.id) return;

    const typing = payload?.typing !== false;

    // Throttle fanout: at most ~1 per 250ms per (user, space, typing-state).
    const key = `spaces:${sender.id}:${spaceId}:${typing ? '1' : '0'}`;
    const now = Date.now();
    this.maybePruneTypingThrottle(now);
    const last = this.typingThrottleByKey.get(key) ?? 0;
    if (now - last < 250) return;
    this.typingThrottleByKey.set(key, now);

    const room = spacesChatRoom(spaceId);
    const out = { spaceId, sender, typing };
    client.to(room).emit('spaces:typing', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:typing', payload: out }).catch(() => undefined);
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

    // Also join/update the corresponding Space (back-compat).
    const spaceId = this.spaces.getSpaceIdByStationId(stationId);
    if (spaceId && this.spacesPresence.isValidSpaceId(spaceId)) {
      const { prevSpaceId, prevRoomSpaceId } = this.spacesPresence.join({ socketId: client.id, userId, spaceId });
      if (prevRoomSpaceId && prevRoomSpaceId !== spaceId) client.leave(spaceRoom(prevRoomSpaceId));
      client.join(spaceRoom(spaceId));
      if (prevSpaceId && prevSpaceId !== spaceId) await this.emitSpaceMembers(prevSpaceId);
      await this.emitSpaceMembers(spaceId);
      this.emitSpacesLobbyCounts();
    }

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

    const spaceId = paused?.stationId ? this.spaces.getSpaceIdByStationId(paused.stationId) : null;
    if (spaceId) {
      const sPaused = this.spacesPresence.pause(client.id);
      if (sPaused?.wasActive && sPaused.changed) {
        await this.emitSpaceMembers(spaceId);
        this.emitSpacesLobbyCounts();
      }
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

    const spaceId = this.spaces.getSpaceIdByStationId(stationId);
    if (spaceId && this.spacesPresence.isValidSpaceId(spaceId)) {
      const { prevRoomSpaceId } = this.spacesPresence.watch({ socketId: client.id, spaceId });
      if (prevRoomSpaceId && prevRoomSpaceId !== spaceId) client.leave(spaceRoom(prevRoomSpaceId));
      client.join(spaceRoom(spaceId));

      const leftSpace = this.spacesPresence.leave(client.id);
      if (leftSpace?.wasActive) {
        await this.emitSpaceMembers(leftSpace.spaceId);
      }
      await this.emitSpaceMembers(spaceId);
      this.emitSpacesLobbyCounts();
    }
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

    const spaceRoomId = this.spacesPresence.getRoomSpaceForSocket(client.id);
    const leftSpace = this.spacesPresence.leave(client.id);
    this.spacesPresence.clearRoomForSocket(client.id);
    if (spaceRoomId) client.leave(spaceRoom(spaceRoomId));
    if (leftSpace?.wasActive) {
      await this.emitSpaceMembers(leftSpace.spaceId);
      this.emitSpacesLobbyCounts();
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

    const spaceId = res?.stationId ? this.spaces.getSpaceIdByStationId(res.stationId) : null;
    if (spaceId) {
      const sRes = this.spacesPresence.setMuted(client.id, Boolean(payload?.muted));
      if (sRes?.wasActive && sRes.changed) {
        await this.emitSpaceMembers(spaceId);
        this.emitSpacesLobbyCounts();
      }
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

  @SubscribeMessage('radio:chatSubscribe')
  handleRadioChatSubscribe(client: Socket, payload: { stationId?: string }): void {
    const stationId = String(payload?.stationId ?? '').trim();
    if (!this.radio.isValidStationId(stationId)) return;

    const prev = String((client.data as any)?.radioChatStationId ?? '').trim() || null;
    if (prev && prev !== stationId) {
      client.leave(radioChatRoom(prev));
    }

    (client.data as any).radioChatStationId = stationId;
    client.join(radioChatRoom(stationId));

    // Canonical storage is space-scoped. Convert snapshot for legacy radio clients.
    const spaceId = this.spaces.getSpaceIdByStationId(stationId);
    if (!spaceId) {
      client.emit('radio:chatSnapshot', this.radioChat.snapshot(stationId));
      return;
    }
    const snap = this.spacesChat.snapshot(spaceId);
    client.emit('radio:chatSnapshot', {
      stationId,
      messages: snap.messages.map((m) => ({
        id: m.id,
        stationId,
        body: m.body,
        createdAt: m.createdAt,
        sender: m.sender,
      })),
    });
  }

  @SubscribeMessage('radio:chatUnsubscribe')
  handleRadioChatUnsubscribe(client: Socket): void {
    const prev = String((client.data as any)?.radioChatStationId ?? '').trim() || null;
    if (!prev) return;
    client.leave(radioChatRoom(prev));
    (client.data as any).radioChatStationId = null;
  }

  @SubscribeMessage('radio:chatSend')
  handleRadioChatSend(client: Socket, payload: { stationId?: string; body?: string }): void {
    const stationId = String(payload?.stationId ?? '').trim();
    const body = String(payload?.body ?? '');
    if (!this.radio.isValidStationId(stationId)) return;

    const subscribed = String((client.data as any)?.radioChatStationId ?? '').trim();
    if (!subscribed || subscribed !== stationId) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const spaceId = this.spaces.getSpaceIdByStationId(stationId);
    if (!spaceId) return;

    // Rate limit for safety (avoid broadcast spam).
    if (!this.spacesChat.canSend(userId)) return;

    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    if (!sender?.id) return;

    const msg = this.spacesChat.appendMessage({ spaceId, sender, body });
    if (!msg) return;

    // Canonical emit (spaces).
    const spacesRoom = spacesChatRoom(spaceId);
    const spacesOut = { spaceId, message: msg };
    this.server.to(spacesRoom).emit('spaces:chatMessage', spacesOut);
    void this.presenceRedis
      .publishEmitToRoom({ room: spacesRoom, event: 'spaces:chatMessage', payload: spacesOut })
      .catch(() => undefined);

    // Legacy emit (radio).
    const room = radioChatRoom(stationId);
    const out = {
      stationId,
      message: {
        id: msg.id,
        stationId,
        body: msg.body,
        createdAt: msg.createdAt,
        sender: msg.sender,
      },
    };
    this.server.to(room).emit('radio:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'radio:chatMessage', payload: out }).catch(() => undefined);
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
        this.presence.persistLastOnlineAt(userId);
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
    this.maybePruneTypingThrottle(now);
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
      this.presence.persistLastOnlineAt(userId);
      this.emitOffline(userId);
    }, idleDisconnectMs);
    const existing = this.userTimers.get(userId);
    this.userTimers.set(userId, { ...existing, idleDisconnectTimer });
  }
}
