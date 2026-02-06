import { Injectable } from '@nestjs/common';
import { RADIO_STATION_IDS } from './radio.constants';

/**
 * In-memory "who is listening to which station" state.
 *
 * - Deduped per user: a user can only be "listening" to one station at a time.
 * - A user is "listening" if they have a station selected (playing or paused).
 * - Paused listeners stay in the list in join order (no separate section).
 */
@Injectable()
export class RadioService {
  /** socketId -> stationId (room subscription; includes paused "watching") */
  private readonly roomStationBySocket = new Map<string, string>();
  /** socketId -> { userId, stationId } (last join from that socket) */
  private readonly stationBySocket = new Map<string, { userId: string; stationId: string }>();
  /** userId -> { stationId, socketId } (current deduped station for this user) */
  private readonly currentByUser = new Map<string, { stationId: string; socketId: string; paused: boolean }>();
  /** stationId -> Set<userId> (deduped current listeners) */
  private readonly usersByStation = new Map<string, Set<string>>();
  /** stationId -> Set<userId> (subset of usersByStation: paused listeners) */
  private readonly pausedByStation = new Map<string, Set<string>>();

  isValidStationId(stationId: string): boolean {
    return RADIO_STATION_IDS.has((stationId ?? '').trim());
  }

  /**
   * Mark a socket as listening to a station.
   * Returns the station the user used to be listening to (if any) so callers can emit updates.
   */
  join(params: {
    socketId: string;
    userId: string;
    stationId: string;
  }): { prevStationId: string | null; prevRoomStationId: string | null } {
    const socketId = (params.socketId ?? '').trim();
    const userId = (params.userId ?? '').trim();
    const stationId = (params.stationId ?? '').trim();
    if (!socketId || !userId || !stationId) return { prevStationId: null, prevRoomStationId: null };

    const prev = this.currentByUser.get(userId) ?? null;
    const prevRoomStationId = this.roomStationBySocket.get(socketId) ?? null;
    this.roomStationBySocket.set(socketId, stationId);

    // Per-socket bookkeeping (used for cleanup on disconnect/leave).
    this.stationBySocket.set(socketId, { userId, stationId });

    // Deduped user -> station mapping (last join wins).
    this.currentByUser.set(userId, { stationId, socketId, paused: false });

    // Remove from previous station set (if station changed).
    if (prev?.stationId && prev.stationId !== stationId) {
      const set = this.usersByStation.get(prev.stationId);
      if (set) {
        set.delete(userId);
        if (set.size === 0) this.usersByStation.delete(prev.stationId);
      }
      const pausedSet = this.pausedByStation.get(prev.stationId);
      if (pausedSet) {
        pausedSet.delete(userId);
        if (pausedSet.size === 0) this.pausedByStation.delete(prev.stationId);
      }
    }

    // Add to next station set.
    let nextSet = this.usersByStation.get(stationId);
    if (!nextSet) {
      nextSet = new Set<string>();
      this.usersByStation.set(stationId, nextSet);
    }
    nextSet.add(userId);

    // Ensure they are not marked paused on this station.
    const pausedSet = this.pausedByStation.get(stationId);
    if (pausedSet) {
      pausedSet.delete(userId);
      if (pausedSet.size === 0) this.pausedByStation.delete(stationId);
    }

    return { prevStationId: prev?.stationId ?? null, prevRoomStationId };
  }

  /**
   * Mark a currently-selected user as paused, without removing them from the listener list.
   * Only applies if this socket is the current deduped socket for the user.
   */
  pause(socketIdRaw: string): { userId: string; stationId: string; wasActive: boolean; changed: boolean } | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;

    const meta = this.stationBySocket.get(socketId);
    if (!meta) return null;

    const current = this.currentByUser.get(meta.userId) ?? null;
    const wasActive = Boolean(current?.socketId === socketId);
    if (!wasActive) {
      return { userId: meta.userId, stationId: meta.stationId, wasActive: false, changed: false };
    }

    const alreadyPaused = Boolean(current?.paused);
    if (!alreadyPaused) {
      this.currentByUser.set(meta.userId, { stationId: meta.stationId, socketId, paused: true });
      let set = this.pausedByStation.get(meta.stationId);
      if (!set) {
        set = new Set<string>();
        this.pausedByStation.set(meta.stationId, set);
      }
      set.add(meta.userId);
    }

    return { userId: meta.userId, stationId: meta.stationId, wasActive: true, changed: !alreadyPaused };
  }

  /**
   * Subscribe a socket to a station room without counting as a listener.
   * (Used for paused "watching": keep getting updates, but don't count toward listeners.)
   */
  watch(params: { socketId: string; stationId: string }): { prevRoomStationId: string | null } {
    const socketId = (params.socketId ?? '').trim();
    const stationId = (params.stationId ?? '').trim();
    if (!socketId || !stationId) return { prevRoomStationId: null };
    const prevRoomStationId = this.roomStationBySocket.get(socketId) ?? null;
    this.roomStationBySocket.set(socketId, stationId);
    return { prevRoomStationId };
  }

  getRoomStationForSocket(socketIdRaw: string): string | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;
    return this.roomStationBySocket.get(socketId) ?? null;
  }

  clearRoomForSocket(socketIdRaw: string): string | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;
    const prev = this.roomStationBySocket.get(socketId) ?? null;
    this.roomStationBySocket.delete(socketId);
    return prev;
  }

  /**
   * Mark a socket as no longer listening.
   * Only clears the user if this socket is the current deduped socket for the user.
   */
  leave(socketIdRaw: string): { userId: string; stationId: string; wasActive: boolean } | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;

    const meta = this.stationBySocket.get(socketId);
    if (!meta) return null;

    this.stationBySocket.delete(socketId);

    const current = this.currentByUser.get(meta.userId) ?? null;
    const wasActive = Boolean(current?.socketId === socketId);
    if (!wasActive) {
      return { userId: meta.userId, stationId: meta.stationId, wasActive: false };
    }

    this.currentByUser.delete(meta.userId);
    const set = this.usersByStation.get(meta.stationId);
    if (set) {
      set.delete(meta.userId);
      if (set.size === 0) this.usersByStation.delete(meta.stationId);
    }
    const pausedSet = this.pausedByStation.get(meta.stationId);
    if (pausedSet) {
      pausedSet.delete(meta.userId);
      if (pausedSet.size === 0) this.pausedByStation.delete(meta.stationId);
    }

    return { userId: meta.userId, stationId: meta.stationId, wasActive: true };
  }

  /** Used on disconnect. */
  onDisconnect(socketId: string): { userId: string; stationId: string; wasActive: boolean } | null {
    this.roomStationBySocket.delete(socketId);
    return this.leave(socketId);
  }

  getListenersForStation(stationIdRaw: string): { userIds: string[]; pausedUserIds: string[] } {
    const stationId = (stationIdRaw ?? '').trim();
    if (!stationId) return { userIds: [], pausedUserIds: [] };
    const set = this.usersByStation.get(stationId);
    if (!set) return { userIds: [], pausedUserIds: [] };
    const pausedSet = this.pausedByStation.get(stationId) ?? new Set<string>();
    const userIds = Array.from(set);
    const pausedUserIds = userIds.filter((id) => pausedSet.has(id));
    return { userIds, pausedUserIds };
  }

  getListenerUserIdsForStation(stationIdRaw: string): string[] {
    return this.getListenersForStation(stationIdRaw).userIds;
  }
}

