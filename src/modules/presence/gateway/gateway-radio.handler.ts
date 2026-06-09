import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { FollowsService } from '../../follows/follows.service';
import { RadioChatService } from '../../radio/radio-chat.service';
import { RadioService } from '../../radio/radio.service';
import type { RadioChatSenderDto, RadioListenerDto, RadioLobbyCountsDto } from '../../../common/dto';
import { PresenceService } from '../presence.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { GatewayContextService } from './gateway-context.service';
import { radioChatRoom } from './gateway-rooms';

/** Radio domain (legacy, standalone): join/pause/watch/leave/mute, lobby counts, radio chat. */
@Injectable()
export class RadioGatewayHandler {
  private readonly logger = new Logger(RadioGatewayHandler.name);

  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly follows: FollowsService,
    private readonly radio: RadioService,
    private readonly radioChat: RadioChatService,
    private readonly context: GatewayContextService,
  ) {}

  // ─── Fan-out helpers ────────────────────────────────────────────────

  async emitRadioListeners(stationId: string): Promise<void> {
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

    this.context.server.to(room).emit('radio:listeners', { stationId: sid, listeners });
  }

  emitRadioLobbyCounts(): void {
    const payload: RadioLobbyCountsDto = {
      countsByStationId: this.radio.getLobbyCountsByStationId(),
    };
    this.context.server.to('radio:lobbies').emit('radio:lobbyCounts', payload);
  }

  // ─── Disconnect cleanup ─────────────────────────────────────────────

  /** Radio portion of socket disconnect (best-effort). */
  handleDisconnect(client: Socket): void {
    try {
      const radioLeft = this.radio.onDisconnect(client.id);
      if (radioLeft?.wasActive) {
        void this.emitRadioListeners(radioLeft.stationId);
        this.emitRadioLobbyCounts();
      }
    } catch (err) {
      this.logger.warn(
        `[presence] disconnect radio cleanup failed socket=${client.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Event handlers ─────────────────────────────────────────────────

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
      this.context.server.sockets.sockets.get(sid)?.emit('radio:replaced', {});
    }
  }

  async handleRadioPause(client: Socket): Promise<void> {
    const paused = this.radio.pause(client.id);
    if (paused?.wasActive && paused.changed) {
      await this.emitRadioListeners(paused.stationId);
      this.emitRadioLobbyCounts();
    }
  }

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

  async handleRadioMute(client: Socket, payload: { muted?: boolean }): Promise<void> {
    const muted = payload?.muted;
    if (typeof muted !== 'boolean') return;
    const res = this.radio.setMuted(client.id, muted);
    if (res?.wasActive && res.changed) {
      await this.emitRadioListeners(res.stationId);
      this.emitRadioLobbyCounts();
    }
  }

  handleRadioLobbiesSubscribe(client: Socket): void {
    client.join('radio:lobbies');
    const payload: RadioLobbyCountsDto = {
      countsByStationId: this.radio.getLobbyCountsByStationId(),
    };
    client.emit('radio:lobbyCounts', payload);
  }

  handleRadioLobbiesUnsubscribe(client: Socket): void {
    client.leave('radio:lobbies');
  }

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

  handleRadioChatUnsubscribe(client: Socket): void {
    const prev = String((client.data as any)?.radioChatStationId ?? '').trim() || null;
    if (!prev) return;
    client.leave(radioChatRoom(prev));
    (client.data as any).radioChatStationId = null;
  }

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
    this.context.server.to(room).emit('radio:chatMessage', out);
    void this.presenceRedis.publishEmitToRoom({ room, event: 'radio:chatMessage', payload: out }).catch(() => undefined);
  }
}
