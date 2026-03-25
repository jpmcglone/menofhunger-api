import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
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
import { WatchPartyStateService } from '../spaces/watch-party-state.service';
import { RedisService } from '../redis/redis.service';
import { RedisKeys } from '../redis/redis-keys';
import type {
  RadioChatSenderDto,
  RadioListenerDto,
  RadioLobbyCountsDto,
  SpaceChatSenderDto,
  SpaceListenerDto,
  SpaceLobbyCountsDto,
} from '../../common/dto';
import {
  WsEventNames,
  type ArticlesSubscribePayloadDto,
  type PostsSubscribePayloadDto,
  type UsersSpaceChangedPayloadDto,
} from '../../common/dto';
import { parseSessionCookieFromHeader } from '../../common/session-cookie';
import { PrismaService } from '../prisma/prisma.service';

type UserTimers = {
  idleMarkTimer?: ReturnType<typeof setTimeout>;
  idleDisconnectTimer?: ReturnType<typeof setTimeout>;
};

const MAX_POST_SUBSCRIPTIONS_PER_SOCKET = 60;
const MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET = 20;
function postRoom(postId: string): string {
  return `post:${postId}`;
}
function articleRoom(articleId: string): string {
  return `article:${articleId}`;
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
export class PresenceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(PresenceGateway.name);
  private readonly logPresenceVerbose: boolean;
  private presenceEventUnsubscribe: (() => void) | null = null;
  private readonly userTimers = new Map<string, UserTimers>();
  private readonly typingThrottleByKey = new Map<string, number>();
  private readonly reactionThrottleByKey = new Map<string, number>();
  private typingThrottleLastPruneAtMs = 0;
  private reactionThrottleLastPruneAtMs = 0;
  private readonly typingThrottlePruneEveryMs = 10_000;
  private readonly typingThrottleEntryTtlMs = 1000 * 60 * 2;
  private readonly reactionThrottlePruneEveryMs = 30_000;
  private readonly reactionThrottleEntryTtlMs = 1000 * 60 * 2;
  private readonly userPresenceNonce = new Map<string, number>();

  /** Short-lived cache: spaceId -> ownerId (avoids DB hits on every WS join) */
  private readonly spaceOwnerCache = new Map<string, { ownerId: string; expiresAt: number }>();
  private readonly SPACE_OWNER_CACHE_TTL_MS = 30_000;

  /** Tracks the primary (most-recently joined) owner socket per space. Only this socket may send watchPartyControl. */
  private readonly primaryOwnerSocketBySpaceId = new Map<string, string>();

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
    private readonly watchPartyState: WatchPartyStateService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.logPresenceVerbose = !this.appConfig.isProd();
  }

  afterInit(server: Server): void {
    this.realtime.setServer(server);

    const myInstanceId = this.presenceRedis.getInstanceId();
    this.presenceEventUnsubscribe = this.presenceRedis.onEvent((evt) => {
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
      } else if (evt.type === 'spacesLobbyCounts') {
        const payload: SpaceLobbyCountsDto = { countsBySpaceId: (evt as any).countsBySpaceId ?? {} };
        this.server.emit('spaces:lobbyCounts', payload);
      } else if (evt.type === 'userSpaceChanged') {
        if ((evt as any).instanceId === myInstanceId) return;
        const uid = (evt as any).userId;
        if (!uid) return;
        const payload: UsersSpaceChangedPayloadDto = {
          userId: uid,
          spaceId: (evt as any).spaceId ?? null,
          previousSpaceId: (evt as any).previousSpaceId,
        };
        const targets = this.getTargetsForUser(uid);
        this.emitToSockets(targets, WsEventNames.usersSpaceChanged, payload);
      }
    });
  }

  onModuleDestroy(): void {
    this.presenceEventUnsubscribe?.();
    this.presenceEventUnsubscribe = null;
  }

  private maybePruneTypingThrottle(nowMs: number): void {
    if (nowMs - this.typingThrottleLastPruneAtMs < this.typingThrottlePruneEveryMs) return;
    this.typingThrottleLastPruneAtMs = nowMs;
    const minMs = nowMs - this.typingThrottleEntryTtlMs;
    for (const [k, lastAt] of this.typingThrottleByKey.entries()) {
      if (lastAt < minMs) this.typingThrottleByKey.delete(k);
    }
  }

  private maybePruneReactionThrottle(nowMs: number): void {
    if (nowMs - this.reactionThrottleLastPruneAtMs < this.reactionThrottlePruneEveryMs) return;
    this.reactionThrottleLastPruneAtMs = nowMs;
    const minMs = nowMs - this.reactionThrottleEntryTtlMs;
    for (const [k, lastAt] of this.reactionThrottleByKey.entries()) {
      if (lastAt < minMs) this.reactionThrottleByKey.delete(k);
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

  private async getCachedSpaceOwnerId(spaceId: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.spaceOwnerCache.get(spaceId);
    if (cached && cached.expiresAt > now) return cached.ownerId;

    const ownerId = await this.spaces.getOwnerIdForSpace(spaceId);
    if (ownerId) {
      this.spaceOwnerCache.set(spaceId, { ownerId, expiresAt: now + this.SPACE_OWNER_CACHE_TTL_MS });
    }
    return ownerId;
  }

  async handleConnection(client: Socket): Promise<void> {
    // Expose a promise that resolves once this async handler finishes.
    // Event handlers that need client.data.userId must await __ready first,
    // because Socket.IO dispatches events before handleConnection resolves.
    let resolveReady!: () => void;
    (client.data as any).__ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    try {
      await this._handleConnectionInner(client);
    } finally {
      resolveReady();
    }
  }

  private async _handleConnectionInner(client: Socket): Promise<void> {
    const cookieHeader = client.handshake.headers.cookie as string | undefined;
    const token = parseSessionCookieFromHeader(cookieHeader);
    let user: any = null;
    try {
      const result = await this.auth.meFromSessionToken(token);
      user = result?.user ?? null;
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

      this.presence.register(client.id, userId, String(clientType));
      const registration = await this.presenceRedis.registerSocket({
        socketId: client.id,
        userId,
        client: String(clientType),
      });
      isNewlyOnline = Boolean(registration?.isNewlyOnline);
      this.presence.persistLastSeenAt(userId);
      this.presence.persistDailyActivity(userId);
    }

    (client.data as { userId?: string; presenceClient?: string }).userId = userId ?? undefined;
    (client.data as { userId?: string; presenceClient?: string }).presenceClient = String(clientType);
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
    if (this.logPresenceVerbose) {
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

    if (userId && isNewlyOnline) {
      await this.emitOnline(userId);
    }
    if (userId) {
      this.scheduleIdleMarkTimer(userId);
    }
  }

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
      const ownerSpaceId = String((client.data as any)?.ownerSpaceId ?? '').trim() || null;
      const spaceLeft = this.spacesPresence.onDisconnect(socketId);
      if (spaceLeft?.wasActive) {
        // If the owner's socket dropped, pause all viewers at the current position.
        if (ownerSpaceId && ownerSpaceId === spaceLeft.spaceId) {
          if (this.primaryOwnerSocketBySpaceId.get(ownerSpaceId) === socketId) {
            this.primaryOwnerSocketBySpaceId.delete(ownerSpaceId);
          }
          const pausedState = this.watchPartyState.pauseAtCurrentPosition(ownerSpaceId);
          if (pausedState) {
            const room = spaceRoom(ownerSpaceId);
            const out = { spaceId: ownerSpaceId, ...pausedState };
            this.server.to(room).emit('spaces:watchPartyState', out);
            void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
          }
        }
        void this.emitSpaceMembers(spaceLeft.spaceId);
        this.emitSpacesLobbyCounts();
      }
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect spaces cleanup failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Space chat leave on disconnect (best-effort).
    // Without this, abrupt disconnects (tab close, network drop) never emit a
    // "left the chat" system message because spaces:chatUnsubscribe isn't sent.
    try {
      const chatSpaceId = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
      const chatSender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
      if (chatSpaceId && chatSender?.id) {
        const leftMsg = this.spacesChat.appendSystemMessage({
          spaceId: chatSpaceId,
          event: 'leave',
          userId: chatSender.id,
          username: chatSender.username ?? null,
        });
        if (leftMsg) {
          const chatRoom = spacesChatRoom(chatSpaceId);
          const out = { spaceId: chatSpaceId, message: leftMsg };
          this.server.to(chatRoom).emit('spaces:chatMessage', out);
          void this.presenceRedis.publishEmitToRoom({ room: chatRoom, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
        }
      }
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect chat cleanup failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
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
    const countsBySpaceId = this.spacesPresence.getLobbyCountsBySpaceId();
    const payload: SpaceLobbyCountsDto = { countsBySpaceId };

    this.server.emit('spaces:lobbyCounts', payload);

    void this.redis
      .setJson(RedisKeys.spacesLobbyCounts(), countsBySpaceId, { ttlSeconds: 120 })
      .catch(() => undefined);

    void this.presenceRedis.publishSpacesLobbyCounts(countsBySpaceId).catch(() => undefined);
  }

  // ─── Spaces ─────────────────────────────────────────────────────────

  @SubscribeMessage('spaces:join')
  async handleSpacesJoin(client: Socket, payload: { spaceId?: string }): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    // Wait for handleConnection's async auth to finish before reading userId.
    // Socket.IO dispatches events immediately on connect, before handleConnection resolves,
    // so without this await the userId would be undefined on hard-reload joins.
    await ((client.data as any).__ready as Promise<void> | undefined)?.catch?.(() => undefined);

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    // Validate space existence: owner can join even if inactive, others require active
    const ownerId = await this.getCachedSpaceOwnerId(spaceId);
    if (!ownerId) return; // space doesn't exist
    const isOwner = ownerId === userId;
    if (!isOwner) {
      const isActive = await this.spaces.isSpaceActive(spaceId);
      if (!isActive) return;
    }

    // Auto-activate on owner join, and elect this socket as the primary control socket.
    if (isOwner) {
      (client.data as any).ownerSpaceId = spaceId;
      void this.spaces.activateSpaceByOwnerId(userId).catch(() => undefined);

      const prevPrimarySocketId = this.primaryOwnerSocketBySpaceId.get(spaceId);
      this.primaryOwnerSocketBySpaceId.set(spaceId, client.id);

      // Tell the previous primary tab it's been replaced (should stop sending control events).
      if (prevPrimarySocketId && prevPrimarySocketId !== client.id) {
        const prevSocket = this.server.sockets.sockets.get(prevPrimarySocketId);
        prevSocket?.emit('spaces:watchPartyOwnerReplaced', { spaceId });
      }
    }

    const { prevSpaceId, prevRoomSpaceId } = this.spacesPresence.join({ socketId: client.id, userId, spaceId });
    if (prevRoomSpaceId && prevRoomSpaceId !== spaceId) {
      client.leave(spaceRoom(prevRoomSpaceId));
    }
    client.join(spaceRoom(spaceId));

    if (prevSpaceId && prevSpaceId !== spaceId) {
      await this.emitSpaceMembers(prevSpaceId);
    }
    await this.emitSpaceMembers(spaceId);
    this.emitSpacesLobbyCounts();

    // Notify subscribers of this user that their space changed
    const spaceChangedDto: UsersSpaceChangedPayloadDto = {
      userId,
      spaceId,
      previousSpaceId: prevSpaceId ?? undefined,
    };
    const targets = this.getTargetsForUser(userId);
    this.emitToSockets(targets, WsEventNames.usersSpaceChanged, spaceChangedDto);
    void this.presenceRedis.publishUserSpaceChanged(spaceChangedDto).catch(() => undefined);

    // Send current watch party state to the joining client (falls back to Redis on server restart).
    const wpState = await this.watchPartyState.getStateAsync(spaceId);
    if (wpState) {
      client.emit('spaces:watchPartyState', { spaceId, ...wpState });
    }
  }

  @SubscribeMessage('spaces:leave')
  async handleSpacesLeave(client: Socket): Promise<void> {
    const ownerSpaceId = String((client.data as any)?.ownerSpaceId ?? '').trim() || null;
    const roomSpaceId = this.spacesPresence.getRoomSpaceForSocket(client.id);
    const left = this.spacesPresence.leave(client.id);
    this.spacesPresence.clearRoomForSocket(client.id);
    if (roomSpaceId) client.leave(spaceRoom(roomSpaceId));
    if (left?.wasActive) {
      // If the owner deliberately leaves, pause all viewers at the current position.
      if (ownerSpaceId && ownerSpaceId === left.spaceId) {
        if (this.primaryOwnerSocketBySpaceId.get(ownerSpaceId) === client.id) {
          this.primaryOwnerSocketBySpaceId.delete(ownerSpaceId);
        }
        const pausedState = this.watchPartyState.pauseAtCurrentPosition(ownerSpaceId);
        if (pausedState) {
          const room = spaceRoom(ownerSpaceId);
          const out = { spaceId: ownerSpaceId, ...pausedState };
          this.server.to(room).emit('spaces:watchPartyState', out);
          void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
        }
      }
      await this.emitSpaceMembers(left.spaceId);
      this.emitSpacesLobbyCounts();

      const userId =
        (client.data as { userId?: string })?.userId ??
        this.presence.getUserIdForSocket(client.id) ??
        null;
      if (userId) {
        const spaceChangedDto: UsersSpaceChangedPayloadDto = {
          userId,
          spaceId: null,
          previousSpaceId: left.spaceId,
        };
        const targets = this.getTargetsForUser(userId);
        this.emitToSockets(targets, WsEventNames.usersSpaceChanged, spaceChangedDto);
        void this.presenceRedis.publishUserSpaceChanged(spaceChangedDto).catch(() => undefined);
      }
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
      // Emit a leave system message for the old space before switching rooms.
      // Normally the client sends spaces:chatUnsubscribe first, but this guards
      // against races where chatSubscribe for the new space arrives first.
      const prevSender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
      if (prevSender?.id) {
        const leftMsg = this.spacesChat.appendSystemMessage({
          spaceId: prev,
          event: 'leave',
          userId: prevSender.id,
          username: prevSender.username ?? null,
        });
        if (leftMsg) {
          const prevRoom = spacesChatRoom(prev);
          const leftOut = { spaceId: prev, message: leftMsg };
          this.server.to(prevRoom).emit('spaces:chatMessage', leftOut);
          void this.presenceRedis.publishEmitToRoom({ room: prevRoom, event: 'spaces:chatMessage', payload: leftOut }).catch(() => undefined);
        }
      }
      client.leave(spacesChatRoom(prev));
    }

    (client.data as any).spaceChatSpaceId = spaceId;
    client.join(spacesChatRoom(spaceId));
    client.emit('spaces:chatSnapshot', this.spacesChat.snapshot(spaceId));

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
  }

  @SubscribeMessage('spaces:chatUnsubscribe')
  handleSpacesChatUnsubscribe(client: Socket): void {
    const prev = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
    if (prev) {
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
  handleSpacesChatSend(client: Socket, payload: { spaceId?: string; body?: string; media?: unknown }): void {
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

    const msg = this.spacesChat.appendMessage({ spaceId, sender, body, media: payload?.media });
    if (!msg) return;

    const room = spacesChatRoom(spaceId);
    const out = { spaceId, message: msg };
    this.server.to(room).emit('spaces:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
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

    const key = `spaces:reaction:${userId}`;
    const now = Date.now();
    this.maybePruneReactionThrottle(now);
    const last = this.reactionThrottleByKey.get(key) ?? 0;
    if (now - last < 400) return;
    this.reactionThrottleByKey.set(key, now);

    const room = spaceRoom(spaceId);
    const out = { spaceId, userId, reactionId: reaction.id, emoji: reaction.emoji };
    this.server.to(room).emit('spaces:reaction', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:reaction', payload: out }).catch(() => undefined);
  }

  @SubscribeMessage('spaces:typing')
  handleSpacesTyping(client: Socket, payload: { spaceId?: string; typing?: boolean }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const subscribed = String((client.data as any)?.spaceChatSpaceId ?? '').trim();
    if (!subscribed || subscribed !== spaceId) return;

    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    if (!sender?.id) return;

    const typing = payload?.typing !== false;

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

  // ─── Mode changes ───────────────────────────────────────────────────

  /**
   * Owner calls this after a successful REST setMode so all viewers learn about the change in real time.
   * The REST endpoint handles DB persistence; this handler handles the broadcast + state cleanup.
   */
  @SubscribeMessage('spaces:announceMode')
  async handleSpacesAnnounceMode(
    client: Socket,
    payload: { spaceId?: string; mode?: string; watchPartyUrl?: string | null; radioStreamUrl?: string | null },
  ): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    const mode = String(payload?.mode ?? '').trim();
    if (!spaceId || !['NONE', 'WATCH_PARTY', 'RADIO'].includes(mode)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const ownerId = await this.getCachedSpaceOwnerId(spaceId);
    if (!ownerId || ownerId !== userId) return;

    // Clear stale watch party state when no longer in WATCH_PARTY mode.
    if (mode !== 'WATCH_PARTY') {
      this.watchPartyState.clearState(spaceId);
    }

    // Clear stale pause flags when leaving RADIO mode so members don't appear
    // paused after switching to watch party or none.
    const pauseCleared = this.spacesPresence.clearAllPaused(spaceId);

    const out = {
      spaceId,
      mode: mode as 'NONE' | 'WATCH_PARTY' | 'RADIO',
      watchPartyUrl: mode === 'WATCH_PARTY' ? (String(payload?.watchPartyUrl ?? '').trim() || null) : null,
      radioStreamUrl: mode === 'RADIO' ? (String(payload?.radioStreamUrl ?? '').trim() || null) : null,
    };

    const room = spaceRoom(spaceId);
    this.server.to(room).emit('spaces:modeChanged', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:modeChanged', payload: out }).catch(() => undefined);

    // Re-broadcast members with cleared pause flags if any were changed.
    if (pauseCleared.length > 0) {
      void this.emitSpaceMembers(spaceId);
    }
  }

  // ─── Watch Party ────────────────────────────────────────────────────

  /** Any client in a space can request the current watch-party state (e.g. on initial mount or reconnect). */
  @SubscribeMessage('spaces:requestWatchPartyState')
  async handleRequestWatchPartyState(client: Socket, payload: { spaceId?: string }): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!spaceId) return;
    // Never serve watch-party state when the space is currently in another mode.
    const mode = await this.spaces.getSpaceMode(spaceId);
    if (mode !== 'WATCH_PARTY') return;
    const state = await this.watchPartyState.getStateAsync(spaceId);
    if (!state) return;
    client.emit('spaces:watchPartyState', { spaceId, ...state });
  }

  @SubscribeMessage('spaces:watchPartyControl')
  async handleWatchPartyControl(
    client: Socket,
    payload: { spaceId?: string; videoUrl?: string; isPlaying?: boolean; currentTime?: number; playbackRate?: number },
  ): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!spaceId) return;
    // Hard invariant: ignore stale watch-party control when the space mode is no longer WATCH_PARTY.
    const mode = await this.spaces.getSpaceMode(spaceId);
    if (mode !== 'WATCH_PARTY') return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    // Only the primary owner socket may send control events (prevents tab fighting).
    const ownerId = await this.getCachedSpaceOwnerId(spaceId);
    if (!ownerId || ownerId !== userId) return;
    if (this.primaryOwnerSocketBySpaceId.get(spaceId) !== client.id) return;

    const videoUrl = String(payload?.videoUrl ?? '').trim();
    if (!videoUrl) return;

    this.watchPartyState.setState(spaceId, {
      videoUrl,
      isPlaying: payload?.isPlaying !== false,
      currentTime: Number(payload?.currentTime ?? 0),
      playbackRate: Number(payload?.playbackRate ?? 1),
    });

    const state = this.watchPartyState.getState(spaceId);
    if (!state) return;

    const room = spaceRoom(spaceId);
    const out = { spaceId, ...state };
    this.server.to(room).emit('spaces:watchPartyState', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
  }

  // ─── Radio (legacy, standalone) ─────────────────────────────────────

  @SubscribeMessage('radio:join')
  async handleRadioJoin(client: Socket, payload: { stationId?: string }): Promise<void> {
    const stationId = (payload?.stationId ?? '').trim();
    if (!this.radio.isValidStationId(stationId)) return;

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;

    const { prevStationId, prevRoomStationId } = this.radio.join({ socketId: client.id, userId, stationId });
    if (prevRoomStationId && prevRoomStationId !== stationId) {
      client.leave(`radio:${prevRoomStationId}`);
    }
    client.join(`radio:${stationId}`);

    if (prevStationId && prevStationId !== stationId) {
      await this.emitRadioListeners(prevStationId);
    }
    await this.emitRadioListeners(stationId);
    this.emitRadioLobbyCounts();

    const otherSocketIds = this.presence.getSocketIdsForUser(userId).filter((id) => id !== client.id);
    for (const sid of otherSocketIds) {
      this.server.sockets.sockets.get(sid)?.emit('radio:replaced', {});
    }
  }

  @SubscribeMessage('radio:pause')
  async handleRadioPause(client: Socket): Promise<void> {
    const paused = this.radio.pause(client.id);
    if (paused?.wasActive && paused.changed) {
      await this.emitRadioListeners(paused.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  @SubscribeMessage('radio:watch')
  async handleRadioWatch(client: Socket, payload: { stationId?: string }): Promise<void> {
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
    client.emit('radio:chatSnapshot', this.radioChat.snapshot(stationId));
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

    if (!this.radioChat.canSend(userId)) return;

    const sender = ((client.data as any)?.radioChatUser ?? null) as RadioChatSenderDto | null;
    if (!sender?.id) return;

    const msg = this.radioChat.appendMessage({ stationId, sender, body });
    if (!msg) return;

    const room = radioChatRoom(stationId);
    const out = { stationId, message: msg };
    this.server.to(room).emit('radio:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'radio:chatMessage', payload: out }).catch(() => undefined);
  }

  // ─── Presence ───────────────────────────────────────────────────────

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
  async handleSubscribe(client: Socket, payload: { userIds?: string[] }): Promise<void> {
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
        const spaceId = this.spacesPresence.getSpaceForUser(uid) ?? undefined;
        return { userId: uid, online, idle, spaceId };
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

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsVerified = Boolean(viewer?.siteAdmin) || Boolean(viewer?.verified);
    const viewerIsPremium = Boolean(viewer?.siteAdmin) || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

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

  @SubscribeMessage('articles:subscribe')
  async handleArticlesSubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): Promise<void> {
    const raw = Array.isArray((payload as any)?.articleIds) ? ((payload as any).articleIds as unknown[]) : [];
    const requested = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (requested.length === 0) return;

    const subs: Set<string> = (client.data as any).articleSubs ?? new Set<string>();
    (client.data as any).articleSubs = subs;
    const remainingCap = Math.max(0, MAX_ARTICLE_SUBSCRIPTIONS_PER_SOCKET - subs.size);
    if (remainingCap <= 0) return;

    const toConsider = Array.from(new Set(requested)).filter((id) => !subs.has(id)).slice(0, remainingCap);
    if (toConsider.length === 0) return;

    const viewerId = (client.data as { userId?: string })?.userId ?? null;
    const viewer = (client.data as any)?.viewer ?? {};
    const viewerIsVerified = Boolean(viewer?.siteAdmin) || Boolean(viewer?.verified);
    const viewerIsPremium = Boolean(viewer?.siteAdmin) || Boolean(viewer?.premium) || Boolean(viewer?.premiumPlus);

    const rows = await this.prisma.article.findMany({
      where: { id: { in: toConsider }, deletedAt: null },
      select: { id: true, authorId: true, visibility: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const accepted: string[] = [];

    for (const articleId of toConsider) {
      const row = byId.get(articleId);
      if (!row) continue;
      const vis = String((row as any).visibility ?? '');
      const isSelf = Boolean(viewerId && row.authorId === viewerId);
      if (vis === 'onlyMe' && !isSelf) continue;
      if (vis === 'verifiedOnly' && !viewerIsVerified && !isSelf) continue;
      if (vis === 'premiumOnly' && !viewerIsPremium && !isSelf) continue;

      subs.add(articleId);
      accepted.push(articleId);
      client.join(articleRoom(articleId));
    }

    if (accepted.length > 0) {
      client.emit(WsEventNames.articlesSubscribed, { articleIds: accepted });
    }
  }

  @SubscribeMessage('articles:unsubscribe')
  handleArticlesUnsubscribe(client: Socket, payload: Partial<ArticlesSubscribePayloadDto>): void {
    const raw = Array.isArray((payload as any)?.articleIds) ? ((payload as any).articleIds as unknown[]) : [];
    const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return;
    const subs: Set<string> = (client.data as any).articleSubs ?? new Set<string>();
    for (const articleId of ids) {
      subs.delete(articleId);
      client.leave(articleRoom(articleId));
    }
    (client.data as any).articleSubs = subs;
  }

  @SubscribeMessage('presence:subscribeOnlineFeed')
  async handleSubscribeOnlineFeed(client: Socket): Promise<void> {
    this.presence.subscribeOnlineFeed(client.id);
    if (this.logPresenceVerbose) {
      this.logger.debug(
        `[presence] SUBSCRIBE_ONLINE_FEED_IN socket=${client.id} feedListeners=${this.presence.getOnlineFeedListeners().size}`,
      );
    }

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
  handleMessagesScreen(client: Socket, payload: { active?: boolean }): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const active = payload?.active !== false;
    this.presence.setChatScreenActive(client.id, active);
  }

  @SubscribeMessage('presence:logout')
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
        this.emitOffline(userId);
      }
    }
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
  }

  @SubscribeMessage('presence:active')
  handleActive(client: Socket): void {
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
