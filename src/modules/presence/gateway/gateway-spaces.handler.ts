import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { FollowsService } from '../../follows/follows.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis-keys';
import { SpacesChatService } from '../../spaces/spaces-chat.service';
import { SpacesPresenceService } from '../../spaces/spaces-presence.service';
import { SpacesService } from '../../spaces/spaces.service';
import { WatchPartyStateService } from '../../spaces/watch-party-state.service';
import type { SpaceChatSenderDto, SpaceListenerDto, SpaceLobbyCountsDto } from '../../../common/dto';
import { WsEventNames, type UsersSpaceChangedPayloadDto } from '../../../common/dto';
import { PresenceService } from '../presence.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { GatewayContextService } from './gateway-context.service';
import { GatewayThrottleService } from './gateway-throttle.service';
import { spaceRoom, spacesChatRoom } from './gateway-rooms';

/**
 * Spaces domain: join/leave/pause/mute, lobby counts, space chat, reactions,
 * typing, mode changes, and watch-party state/control — including the
 * owner-socket election that prevents multiple owner tabs from fighting over
 * playback control.
 *
 * Lobby *counts* are aggregated via Redis across instances. Member lists and
 * primary-owner election remain process-local (single-gateway sticky); a
 * multi-instance owner/member roster would need shared Redis membership.
 */
@Injectable()
export class SpacesGatewayHandler {
  private readonly logger = new Logger(SpacesGatewayHandler.name);

  /** Short-lived cache: spaceId -> ownerId (avoids DB hits on every WS join) */
  private readonly spaceOwnerCache = new Map<string, { ownerId: string; expiresAt: number }>();
  private readonly SPACE_OWNER_CACHE_TTL_MS = 30_000;

  /** Tracks the primary (most-recently joined) owner socket per space. Only this socket may send watchPartyControl. */
  private readonly primaryOwnerSocketBySpaceId = new Map<string, string>();

  /** Tracks ALL owner sockets per space (across tabs) so we can re-elect on primary disconnect. */
  private readonly ownerSocketsBySpaceId = new Map<string, Set<string>>();

  /**
   * Last-owner disconnect must not take the room offline immediately — a phone
   * blip / Socket.IO reconnect would otherwise deactivate the space and every
   * waiter’s re-join would silently fail. Explicit leave still ends it now.
   */
  static readonly OWNER_GONE_GRACE_MS = 20_000;
  private readonly ownerGoneTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly follows: FollowsService,
    private readonly spaces: SpacesService,
    private readonly spacesPresence: SpacesPresenceService,
    private readonly spacesChat: SpacesChatService,
    private readonly watchPartyState: WatchPartyStateService,
    private readonly redis: RedisService,
    private readonly throttle: GatewayThrottleService,
    private readonly context: GatewayContextService,
  ) {}

  private async getCachedSpaceOwnerId(spaceId: string): Promise<string | null> {
    const now = Date.now();
    // Opportunistic prune so expired spaceIds don't linger for the process lifetime.
    if (this.spaceOwnerCache.size > 64) {
      for (const [id, entry] of this.spaceOwnerCache) {
        if (entry.expiresAt <= now) this.spaceOwnerCache.delete(id);
      }
    }
    const cached = this.spaceOwnerCache.get(spaceId);
    if (cached && cached.expiresAt > now) return cached.ownerId;
    if (cached) this.spaceOwnerCache.delete(spaceId);

    const ownerId = await this.spaces.getOwnerIdForSpace(spaceId);
    if (ownerId) {
      this.spaceOwnerCache.set(spaceId, { ownerId, expiresAt: now + this.SPACE_OWNER_CACHE_TTL_MS });
    }
    return ownerId;
  }

  /**
   * Opening `/s/:username` puts you in that room. `isActive` is "on air"
   * (watch party / radio), not a door lock — idle hangouts still have a lobby
   * and chat. Missing owner means the space is gone.
   */
  private async resolveSpaceAccess(
    userId: string,
    spaceId: string,
  ): Promise<{ ownerId: string; isOwner: boolean } | null> {
    const ownerId = await this.getCachedSpaceOwnerId(spaceId);
    if (!ownerId) return null;
    return { ownerId, isOwner: ownerId === userId };
  }

  private cancelOwnerGoneDeactivate(spaceId: string): void {
    const timer = this.ownerGoneTimers.get(spaceId);
    if (!timer) return;
    clearTimeout(timer);
    this.ownerGoneTimers.delete(spaceId);
  }

  private scheduleOwnerGoneDeactivate(spaceId: string): void {
    this.cancelOwnerGoneDeactivate(spaceId);
    const timer = setTimeout(() => {
      this.ownerGoneTimers.delete(spaceId);
      if ((this.ownerSocketsBySpaceId.get(spaceId)?.size ?? 0) > 0) return;
      void this.spaces
        .deactivateIfActive(spaceId)
        .then((did) => {
          if (did) this.emitSpacesLobbyCounts();
        })
        .catch(() => undefined);
    }, SpacesGatewayHandler.OWNER_GONE_GRACE_MS);
    timer.unref?.();
    this.ownerGoneTimers.set(spaceId, timer);
  }

  /**
   * Remove a socket from owner-election maps and re-elect primary when needed.
   * Returns true when no owner sockets remain for the space (room is leaderless).
   */
  private clearOwnerSocket(
    socketId: string,
    ownerSpaceId: string,
    opts?: { pauseWatchParty?: boolean; deactivateImmediately?: boolean },
  ): boolean {
    const spaceId = String(ownerSpaceId ?? '').trim();
    const sid = String(socketId ?? '').trim();
    if (!spaceId || !sid) return false;

    const ownerSockets = this.ownerSocketsBySpaceId.get(spaceId);
    if (ownerSockets) {
      ownerSockets.delete(sid);
      if (ownerSockets.size === 0) this.ownerSocketsBySpaceId.delete(spaceId);
    }

    const wasPrimary = this.primaryOwnerSocketBySpaceId.get(spaceId) === sid;
    if (wasPrimary) {
      this.primaryOwnerSocketBySpaceId.delete(spaceId);
      const remaining = ownerSockets ? [...ownerSockets] : [];
      if (remaining.length > 0) {
        const newPrimaryId = remaining[remaining.length - 1]!;
        this.primaryOwnerSocketBySpaceId.set(spaceId, newPrimaryId);
        const newPrimarySocket = this.context.server.sockets.sockets.get(newPrimaryId);
        newPrimarySocket?.emit('spaces:watchPartyOwnerPromoted', { spaceId });
      } else if (opts?.pauseWatchParty) {
        const pausedState = this.watchPartyState.pauseAtCurrentPosition(spaceId);
        if (pausedState) {
          const room = spaceRoom(spaceId);
          const out = { spaceId, ...pausedState };
          this.context.server.to(room).emit('spaces:watchPartyState', out);
          void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
        }
      }
    }

    const ownerGone = (this.ownerSocketsBySpaceId.get(spaceId)?.size ?? 0) === 0;
    if (ownerGone) {
      if (opts?.deactivateImmediately) {
        this.cancelOwnerGoneDeactivate(spaceId);
        void this.spaces
          .deactivateIfActive(spaceId)
          .then((did) => {
            if (did) this.emitSpacesLobbyCounts();
          })
          .catch(() => undefined);
      } else {
        this.scheduleOwnerGoneDeactivate(spaceId);
      }
    }
    return ownerGone;
  }

  // ─── Fan-out helpers ────────────────────────────────────────────────

  async emitSpaceMembers(spaceId: string, alsoTo?: Socket): Promise<void> {
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
          listeners.push({
            id,
            username: u?.username ?? null,
            avatarUrl: u?.avatarUrl ?? null,
            premium: u?.premium ?? false,
            premiumPlus: u?.premiumPlus ?? false,
            isOrganization: u?.isOrganization ?? false,
            verifiedStatus: (u?.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
            paused: pausedSet.has(id),
            muted: mutedSet.has(id),
          });
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch space members for space ${sid}: ${err}`);
      }
    }

    const payload = { spaceId: sid, members: listeners };
    this.context.server.to(room).emit('spaces:members', payload);
    // Joiner always gets the roster on their socket — room broadcast can miss
    // the same tick as join(), which showed up as "0 here" after a reconnect
    // or while impersonating.
    if (alsoTo && alsoTo.connected !== false) {
      alsoTo.emit('spaces:members', payload);
    }
  }

  emitSpacesLobbyCounts(): void {
    void this.emitSpacesLobbyCountsAsync();
  }

  private async emitSpacesLobbyCountsAsync(): Promise<void> {
    const local = this.spacesPresence.getLobbyCountsBySpaceId();
    const countsBySpaceId = await this.presenceRedis.syncAndAggregateLobbyCounts(local);
    const payload: SpaceLobbyCountsDto = { countsBySpaceId };

    this.context.server.emit('spaces:lobbyCounts', payload);

    void this.redis
      .setJson(RedisKeys.spacesLobbyCounts(), countsBySpaceId, { ttlSeconds: 30 })
      .catch(() => undefined);

    void this.presenceRedis.publishSpacesLobbyCounts(countsBySpaceId).catch(() => undefined);
  }

  // ─── Disconnect cleanup ─────────────────────────────────────────────

  /**
   * Spaces + space-chat portion of socket disconnect. `fallbackUserId` is the
   * user id resolved by the presence unregister (the socket's data may be gone).
   */
  handleDisconnect(client: Socket, fallbackUserId: string): void {
    const socketId = client.id;

    // Spaces cleanup (best-effort).
    try {
      const ownerSpaceId = String((client.data as any)?.ownerSpaceId ?? '').trim() || null;
      const spaceLeft = this.spacesPresence.onDisconnect(socketId);
      // Always clear owner-socket maps for this socket. Leaving an owned space by
      // joining elsewhere used to leave stale entries because cleanup only ran when
      // ownerSpaceId === left.spaceId.
      if (ownerSpaceId) {
        this.clearOwnerSocket(socketId, ownerSpaceId, {
          pauseWatchParty: Boolean(spaceLeft?.wasActive && spaceLeft.spaceId === ownerSpaceId),
        });
        (client.data as any).ownerSpaceId = null;
      }
      if (spaceLeft?.wasActive) {
        void this.emitSpaceMembers(spaceLeft.spaceId);
        this.emitSpacesLobbyCounts();
        const spaceUserId = String(spaceLeft.userId ?? fallbackUserId ?? '').trim();
        if (spaceUserId) {
          const spaceChangedDto: UsersSpaceChangedPayloadDto = {
            userId: spaceUserId,
            spaceId: null,
            previousSpaceId: spaceLeft.spaceId,
          };
          const targets = this.context.getTargetsForUser(spaceUserId);
          this.context.emitToSockets(targets, WsEventNames.usersSpaceChanged, spaceChangedDto);
          void this.presenceRedis.publishUserSpaceChanged(spaceChangedDto).catch(() => undefined);
        }
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
      if (chatSpaceId) this.emitChatSystemIfSoleSocket(client, chatSpaceId, 'leave');
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect chat cleanup failed socket=${socketId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Event handlers ─────────────────────────────────────────────────

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

    const access = await this.resolveSpaceAccess(userId, spaceId);
    if (!access) return;
    const { isOwner } = access;

    // Clear prior owner-socket tracking when this socket moves to another space
    // (owned or not). Otherwise owner maps retain stale socket ids forever.
    const prevOwnerSpaceId = String((client.data as any)?.ownerSpaceId ?? '').trim() || null;
    if (prevOwnerSpaceId && prevOwnerSpaceId !== spaceId) {
      this.clearOwnerSocket(client.id, prevOwnerSpaceId, {
        pauseWatchParty: true,
        deactivateImmediately: true,
      });
      (client.data as any).ownerSpaceId = null;
    }

    // Elect this socket as the primary control socket. Going live is explicit
    // (owner panel "Go live") — joining a scheduled/inactive space must not activate it.
    if (isOwner) {
      this.cancelOwnerGoneDeactivate(spaceId);
      (client.data as any).ownerSpaceId = spaceId;

      // Track in the full owner-socket set for this space (all tabs).
      if (!this.ownerSocketsBySpaceId.has(spaceId)) {
        this.ownerSocketsBySpaceId.set(spaceId, new Set());
      }
      this.ownerSocketsBySpaceId.get(spaceId)!.add(client.id);

      const prevPrimarySocketId = this.primaryOwnerSocketBySpaceId.get(spaceId);
      this.primaryOwnerSocketBySpaceId.set(spaceId, client.id);

      // Tell the previous primary tab it's been replaced (should stop sending control events).
      if (prevPrimarySocketId && prevPrimarySocketId !== client.id) {
        const prevSocket = this.context.server.sockets.sockets.get(prevPrimarySocketId);
        prevSocket?.emit('spaces:watchPartyOwnerReplaced', { spaceId });
      }
    } else {
      (client.data as any).ownerSpaceId = null;
    }

    const { prevSpaceId, prevRoomSpaceId } = this.spacesPresence.join({ socketId: client.id, userId, spaceId });
    if (prevRoomSpaceId && prevRoomSpaceId !== spaceId) {
      client.leave(spaceRoom(prevRoomSpaceId));
    }
    client.join(spaceRoom(spaceId));

    if (prevSpaceId && prevSpaceId !== spaceId) {
      await this.emitSpaceMembers(prevSpaceId);
    }
    await this.emitSpaceMembers(spaceId, client);
    this.emitSpacesLobbyCounts();

    // Notify subscribers of this user that their space changed
    const spaceChangedDto: UsersSpaceChangedPayloadDto = {
      userId,
      spaceId,
      previousSpaceId: prevSpaceId ?? undefined,
    };
    const targets = this.context.getTargetsForUser(userId);
    this.context.emitToSockets(targets, WsEventNames.usersSpaceChanged, spaceChangedDto);
    void this.presenceRedis.publishUserSpaceChanged(spaceChangedDto).catch(() => undefined);

    // Send current watch party state to the joining client (falls back to Redis on server restart).
    const wpState = await this.watchPartyState.getStateAsync(spaceId);
    if (wpState) {
      client.emit('spaces:watchPartyState', { spaceId, ...wpState });
    }
  }

  async handleSpacesLeave(client: Socket): Promise<void> {
    const ownerSpaceId = String((client.data as any)?.ownerSpaceId ?? '').trim() || null;
    const roomSpaceId = this.spacesPresence.getRoomSpaceForSocket(client.id);
    const left = this.spacesPresence.leave(client.id);
    this.spacesPresence.clearRoomForSocket(client.id);
    if (roomSpaceId) client.leave(spaceRoom(roomSpaceId));
    if (ownerSpaceId) {
      this.clearOwnerSocket(client.id, ownerSpaceId, {
        pauseWatchParty: Boolean(left?.wasActive && left.spaceId === ownerSpaceId),
        deactivateImmediately: true,
      });
      (client.data as any).ownerSpaceId = null;
    }
    if (left?.wasActive) {
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
        const targets = this.context.getTargetsForUser(userId);
        this.context.emitToSockets(targets, WsEventNames.usersSpaceChanged, spaceChangedDto);
        void this.presenceRedis.publishUserSpaceChanged(spaceChangedDto).catch(() => undefined);
      }
    }
  }

  async handleSpacesPause(client: Socket): Promise<void> {
    const paused = this.spacesPresence.pause(client.id);
    if (paused?.wasActive && paused.changed) {
      await this.emitSpaceMembers(paused.spaceId);
      this.emitSpacesLobbyCounts();
    }
  }

  async handleSpacesMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    const muted = payload?.muted;
    if (typeof muted !== 'boolean') return;
    const res = this.spacesPresence.setMuted(client.id, muted);
    if (res?.wasActive && res.changed) {
      await this.emitSpaceMembers(res.spaceId);
      this.emitSpacesLobbyCounts();
    }
  }

  handleSpacesLobbiesSubscribe(client: Socket): void {
    client.join('spaces:lobbies');
    void this.emitLobbyCountsToClient(client);
  }

  private async emitLobbyCountsToClient(client: Socket): Promise<void> {
    const local = this.spacesPresence.getLobbyCountsBySpaceId();
    const countsBySpaceId = await this.presenceRedis.syncAndAggregateLobbyCounts(local);
    const payload: SpaceLobbyCountsDto = { countsBySpaceId };
    client.emit('spaces:lobbyCounts', payload);
  }

  handleSpacesLobbiesUnsubscribe(client: Socket): void {
    client.leave('spaces:lobbies');
  }

  /** Other sockets for this user already subscribed to this space's chat (exclude `exceptSocketId`). */
  private otherUserChatSockets(spaceId: string, userId: string, exceptSocketId: string): number {
    const sockets = this.context.server?.sockets?.sockets;
    if (!sockets) return 0;
    let n = 0;
    for (const sock of sockets.values()) {
      if (sock.id === exceptSocketId) continue;
      const sid = String((sock.data as { spaceChatSpaceId?: string } | undefined)?.spaceChatSpaceId ?? '').trim();
      if (sid !== spaceId) continue;
      const uid = String(
        (sock.data as { userId?: string; spaceChatUser?: { id?: string } } | undefined)?.userId
          ?? (sock.data as { spaceChatUser?: { id?: string } } | undefined)?.spaceChatUser?.id
          ?? '',
      ).trim();
      if (uid === userId) n += 1;
    }
    return n;
  }

  /** Join when this is the user's first chat socket; leave when it is the last. */
  private emitChatSystemIfSoleSocket(client: Socket, spaceId: string, event: 'join' | 'leave'): void {
    const sender = ((client.data as { spaceChatUser?: SpaceChatSenderDto })?.spaceChatUser ?? null);
    const userId = String(sender?.id ?? '').trim();
    if (!sender?.id || !userId) return;
    if (this.otherUserChatSockets(spaceId, userId, client.id) > 0) return;
    const msg = this.spacesChat.appendSystemMessage({
      spaceId,
      event,
      userId: sender.id,
      username: sender.username ?? null,
    });
    if (!msg) return;
    const room = spacesChatRoom(spaceId);
    const out = { spaceId, message: msg };
    this.context.server.to(room).emit('spaces:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
  }

  async handleSpacesChatSubscribe(client: Socket, payload: { spaceId?: string }): Promise<void> {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    await ((client.data as any).__ready as Promise<void> | undefined)?.catch?.(() => undefined);

    const userId =
      (client.data as { userId?: string })?.userId ??
      this.presence.getUserIdForSocket(client.id) ??
      null;
    if (!userId) return;
    if (!(await this.resolveSpaceAccess(userId, spaceId))) return;

    const prev = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
    if (prev && prev !== spaceId) {
      // Emit a leave system message for the old space before switching rooms.
      // Normally the client sends spaces:chatUnsubscribe first, but this guards
      // against races where chatSubscribe for the new space arrives first.
      this.emitChatSystemIfSoleSocket(client, prev, 'leave');
      client.leave(spacesChatRoom(prev));
    }

    (client.data as any).spaceChatSpaceId = spaceId;
    client.join(spacesChatRoom(spaceId));
    // Append the join line first so the snapshot the joiner gets already
    // includes it — a room broadcast alone can lose the race and show
    // "No messages yet" with no "@you has joined".
    this.emitChatSystemIfSoleSocket(client, spaceId, 'join');
    client.emit('spaces:chatSnapshot', this.spacesChat.snapshot(spaceId));
  }

  handleSpacesChatUnsubscribe(client: Socket): void {
    const prev = String((client.data as any)?.spaceChatSpaceId ?? '').trim() || null;
    if (prev) {
      this.emitChatSystemIfSoleSocket(client, prev, 'leave');
      client.leave(spacesChatRoom(prev));
    }
    (client.data as any).spaceChatSpaceId = null;
  }

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
    this.context.server.to(room).emit('spaces:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
  }

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

    if (!this.throttle.shouldEmitReaction(`spaces:reaction:${userId}`, 400)) return;

    const room = spaceRoom(spaceId);
    const out = { spaceId, userId, reactionId: reaction.id, emoji: reaction.emoji };
    this.context.server.to(room).emit('spaces:reaction', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:reaction', payload: out }).catch(() => undefined);
  }

  handleSpacesTyping(client: Socket, payload: { spaceId?: string; typing?: boolean }): void {
    const spaceId = String(payload?.spaceId ?? '').trim();
    if (!this.spacesPresence.isValidSpaceId(spaceId)) return;

    const subscribed = String((client.data as any)?.spaceChatSpaceId ?? '').trim();
    if (!subscribed || subscribed !== spaceId) return;

    const sender = ((client.data as any)?.spaceChatUser ?? null) as SpaceChatSenderDto | null;
    if (!sender?.id) return;

    const typing = payload?.typing !== false;

    if (!this.throttle.shouldEmitTyping(`spaces:${sender.id}:${spaceId}:${typing ? '1' : '0'}`, 250)) return;

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

    const newWatchPartyUrl = mode === 'WATCH_PARTY' ? (String(payload?.watchPartyUrl ?? '').trim() || null) : null;

    // Clear stale watch party state when no longer in WATCH_PARTY mode.
    if (mode !== 'WATCH_PARTY') {
      this.watchPartyState.clearState(spaceId);
    } else if (newWatchPartyUrl !== null) {
      // When staying in WATCH_PARTY mode but the video URL changes (or is set for
      // the first time), reset the state to paused-at-0 for the new video so late
      // joiners see the correct video + position even before the owner's player emits.
      const existingState = this.watchPartyState.getState(spaceId);
      if (!existingState || existingState.videoUrl !== newWatchPartyUrl) {
        this.watchPartyState.resetForVideo(spaceId, newWatchPartyUrl);
        // Broadcast the reset state to the room immediately.
        const resetState = this.watchPartyState.getState(spaceId);
        if (resetState) {
          const room = spaceRoom(spaceId);
          const resetOut = { spaceId, ...resetState };
          this.context.server.to(room).emit('spaces:watchPartyState', resetOut);
          void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: resetOut }).catch(() => undefined);
        }
      }
    }

    // Clear stale pause flags when leaving RADIO mode so members don't appear
    // paused after switching to watch party or none.
    const pauseCleared = this.spacesPresence.clearAllPaused(spaceId);

    const out = {
      spaceId,
      mode: mode as 'NONE' | 'WATCH_PARTY' | 'RADIO',
      watchPartyUrl: newWatchPartyUrl,
      radioStreamUrl: mode === 'RADIO' ? (String(payload?.radioStreamUrl ?? '').trim() || null) : null,
    };

    const room = spaceRoom(spaceId);
    this.context.server.to(room).emit('spaces:modeChanged', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:modeChanged', payload: out }).catch(() => undefined);

    // Re-broadcast members with cleared pause flags if any were changed.
    if (pauseCleared.length > 0) {
      void this.emitSpaceMembers(spaceId);
    }
  }

  // ─── Watch Party ────────────────────────────────────────────────────

  /** Any client in a space can request the current watch-party state (e.g. on initial mount or reconnect). */
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
      isPlaying: Boolean(payload?.isPlaying),
      currentTime: Number(payload?.currentTime ?? 0),
      playbackRate: Number(payload?.playbackRate ?? 1),
    });

    const state = this.watchPartyState.getState(spaceId);
    if (!state) return;

    const room = spaceRoom(spaceId);
    const out = { spaceId, ...state };
    this.context.server.to(room).emit('spaces:watchPartyState', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
  }
}
