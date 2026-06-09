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
    const cached = this.spaceOwnerCache.get(spaceId);
    if (cached && cached.expiresAt > now) return cached.ownerId;

    const ownerId = await this.spaces.getOwnerIdForSpace(spaceId);
    if (ownerId) {
      this.spaceOwnerCache.set(spaceId, { ownerId, expiresAt: now + this.SPACE_OWNER_CACHE_TTL_MS });
    }
    return ownerId;
  }

  // ─── Fan-out helpers ────────────────────────────────────────────────

  async emitSpaceMembers(spaceId: string): Promise<void> {
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

    this.context.server.to(room).emit('spaces:members', { spaceId: sid, members: listeners });
  }

  emitSpacesLobbyCounts(): void {
    const countsBySpaceId = this.spacesPresence.getLobbyCountsBySpaceId();
    const payload: SpaceLobbyCountsDto = { countsBySpaceId };

    this.context.server.emit('spaces:lobbyCounts', payload);

    void this.redis
      .setJson(RedisKeys.spacesLobbyCounts(), countsBySpaceId, { ttlSeconds: 120 })
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
      if (spaceLeft?.wasActive) {
        // If the owner's socket dropped, pause all viewers at the current position.
        if (ownerSpaceId && ownerSpaceId === spaceLeft.spaceId) {
          // Remove from the owner-socket set.
          const ownerSockets = this.ownerSocketsBySpaceId.get(ownerSpaceId);
          if (ownerSockets) {
            ownerSockets.delete(socketId);
          }

          const wasPrimary = this.primaryOwnerSocketBySpaceId.get(ownerSpaceId) === socketId;
          if (wasPrimary) {
            this.primaryOwnerSocketBySpaceId.delete(ownerSpaceId);

            // Re-elect another owner socket if one is still connected. That tab
            // gets `spaces:watchPartyOwnerPromoted` so it clears `isReplacedOwner`
            // and can start driving playback again.
            const remaining = ownerSockets ? [...ownerSockets].filter((id) => id !== socketId) : [];
            if (remaining.length > 0) {
              const newPrimaryId = remaining[remaining.length - 1]!;
              this.primaryOwnerSocketBySpaceId.set(ownerSpaceId, newPrimaryId);
              const newPrimarySocket = this.context.server.sockets.sockets.get(newPrimaryId);
              newPrimarySocket?.emit('spaces:watchPartyOwnerPromoted', { spaceId: ownerSpaceId });
            }
          }

          if (ownerSockets && ownerSockets.size === 0) {
            this.ownerSocketsBySpaceId.delete(ownerSpaceId);
          }

          const pausedState = this.watchPartyState.pauseAtCurrentPosition(ownerSpaceId);
          if (pausedState) {
            const room = spaceRoom(ownerSpaceId);
            const out = { spaceId: ownerSpaceId, ...pausedState };
            this.context.server.to(room).emit('spaces:watchPartyState', out);
            void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:watchPartyState', payload: out }).catch(() => undefined);
          }
        }
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
          this.context.server.to(chatRoom).emit('spaces:chatMessage', out);
          void this.presenceRedis.publishEmitToRoom({ room: chatRoom, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
        }
      }
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
    if (left?.wasActive) {
      // If the owner deliberately leaves, pause all viewers at the current position.
      if (ownerSpaceId && ownerSpaceId === left.spaceId) {
        // Remove from the owner-socket set; clear primary if it was this socket.
        const ownerSockets = this.ownerSocketsBySpaceId.get(ownerSpaceId);
        if (ownerSockets) {
          ownerSockets.delete(client.id);
          if (ownerSockets.size === 0) this.ownerSocketsBySpaceId.delete(ownerSpaceId);
        }
        if (this.primaryOwnerSocketBySpaceId.get(ownerSpaceId) === client.id) {
          this.primaryOwnerSocketBySpaceId.delete(ownerSpaceId);
        }
        const pausedState = this.watchPartyState.pauseAtCurrentPosition(ownerSpaceId);
        if (pausedState) {
          const room = spaceRoom(ownerSpaceId);
          const out = { spaceId: ownerSpaceId, ...pausedState };
          this.context.server.to(room).emit('spaces:watchPartyState', out);
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
    const payload: SpaceLobbyCountsDto = {
      countsBySpaceId: this.spacesPresence.getLobbyCountsBySpaceId(),
    };
    client.emit('spaces:lobbyCounts', payload);
  }

  handleSpacesLobbiesUnsubscribe(client: Socket): void {
    client.leave('spaces:lobbies');
  }

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
          this.context.server.to(prevRoom).emit('spaces:chatMessage', leftOut);
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
      this.context.server.to(room).emit('spaces:chatMessage', out);
      void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
    }
  }

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
        this.context.server.to(room).emit('spaces:chatMessage', out);
        void this.presenceRedis.publishEmitToRoom({ room, event: 'spaces:chatMessage', payload: out }).catch(() => undefined);
      }
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
