import { Injectable } from '@nestjs/common';
import { SPACE_IDS } from './spaces.constants';

/**
 * In-memory "who is in which space" state.
 *
 * - Deduped per user: a user can only be "in" one space at a time.
 * - A user is "in" a space once they select/enter it (not tied to music playback).
 */
@Injectable()
export class SpacesPresenceService {
  /** socketId -> spaceId (room subscription; includes passive "watching") */
  private readonly roomSpaceBySocket = new Map<string, string>();
  /** socketId -> { userId, spaceId } (last join from that socket) */
  private readonly spaceBySocket = new Map<string, { userId: string; spaceId: string }>();
  /** userId -> { spaceId, socketId } (current deduped space for this user) */
  private readonly currentByUser = new Map<string, { spaceId: string; socketId: string; paused: boolean; muted: boolean }>();
  /** spaceId -> Set<userId> (deduped current members) */
  private readonly usersBySpace = new Map<string, Set<string>>();
  /** spaceId -> Set<userId> (subset of usersBySpace: paused members) */
  private readonly pausedBySpace = new Map<string, Set<string>>();
  /** spaceId -> Set<userId> (subset of usersBySpace: muted members) */
  private readonly mutedBySpace = new Map<string, Set<string>>();

  isValidSpaceId(spaceId: string): boolean {
    return SPACE_IDS.has((spaceId ?? '').trim());
  }

  join(params: { socketId: string; userId: string; spaceId: string }): { prevSpaceId: string | null; prevRoomSpaceId: string | null } {
    const socketId = (params.socketId ?? '').trim();
    const userId = (params.userId ?? '').trim();
    const spaceId = (params.spaceId ?? '').trim();
    if (!socketId || !userId || !spaceId) return { prevSpaceId: null, prevRoomSpaceId: null };

    const prev = this.currentByUser.get(userId) ?? null;
    const prevRoomSpaceId = this.roomSpaceBySocket.get(socketId) ?? null;
    this.roomSpaceBySocket.set(socketId, spaceId);

    this.spaceBySocket.set(socketId, { userId, spaceId });
    this.currentByUser.set(userId, { spaceId, socketId, paused: false, muted: false });

    if (prev?.spaceId && prev.spaceId !== spaceId) {
      const set = this.usersBySpace.get(prev.spaceId);
      if (set) {
        set.delete(userId);
        if (set.size === 0) this.usersBySpace.delete(prev.spaceId);
      }
      const pausedSet = this.pausedBySpace.get(prev.spaceId);
      if (pausedSet) {
        pausedSet.delete(userId);
        if (pausedSet.size === 0) this.pausedBySpace.delete(prev.spaceId);
      }
      const mutedSet = this.mutedBySpace.get(prev.spaceId);
      if (mutedSet) {
        mutedSet.delete(userId);
        if (mutedSet.size === 0) this.mutedBySpace.delete(prev.spaceId);
      }
    }

    let nextSet = this.usersBySpace.get(spaceId);
    if (!nextSet) {
      nextSet = new Set<string>();
      this.usersBySpace.set(spaceId, nextSet);
    }
    nextSet.add(userId);

    const pausedSet = this.pausedBySpace.get(spaceId);
    if (pausedSet) {
      pausedSet.delete(userId);
      if (pausedSet.size === 0) this.pausedBySpace.delete(spaceId);
    }
    const mutedSet = this.mutedBySpace.get(spaceId);
    if (mutedSet) {
      mutedSet.delete(userId);
      if (mutedSet.size === 0) this.mutedBySpace.delete(spaceId);
    }

    return { prevSpaceId: prev?.spaceId ?? null, prevRoomSpaceId };
  }

  pause(socketIdRaw: string): { userId: string; spaceId: string; wasActive: boolean; changed: boolean } | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;

    const meta = this.spaceBySocket.get(socketId);
    if (!meta) return null;

    const current = this.currentByUser.get(meta.userId) ?? null;
    const wasActive = Boolean(current?.socketId === socketId);
    if (!wasActive) {
      return { userId: meta.userId, spaceId: meta.spaceId, wasActive: false, changed: false };
    }

    const alreadyPaused = Boolean(current?.paused);
    if (!alreadyPaused) {
      this.currentByUser.set(meta.userId, {
        spaceId: meta.spaceId,
        socketId,
        paused: true,
        muted: Boolean(current?.muted),
      });
      let set = this.pausedBySpace.get(meta.spaceId);
      if (!set) {
        set = new Set<string>();
        this.pausedBySpace.set(meta.spaceId, set);
      }
      set.add(meta.userId);
    }

    return { userId: meta.userId, spaceId: meta.spaceId, wasActive: true, changed: !alreadyPaused };
  }

  setMuted(socketIdRaw: string, mutedRaw: boolean): { userId: string; spaceId: string; wasActive: boolean; changed: boolean } | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;
    const meta = this.spaceBySocket.get(socketId);
    if (!meta) return null;

    const current = this.currentByUser.get(meta.userId) ?? null;
    const wasActive = Boolean(current?.socketId === socketId);
    if (!wasActive) {
      return { userId: meta.userId, spaceId: meta.spaceId, wasActive: false, changed: false };
    }

    const nextMuted = Boolean(mutedRaw);
    const alreadyMuted = Boolean(current?.muted);
    const changed = alreadyMuted !== nextMuted;
    if (!changed) {
      return { userId: meta.userId, spaceId: meta.spaceId, wasActive: true, changed: false };
    }

    this.currentByUser.set(meta.userId, {
      spaceId: meta.spaceId,
      socketId,
      paused: Boolean(current?.paused),
      muted: nextMuted,
    });

    let set = this.mutedBySpace.get(meta.spaceId);
    if (nextMuted) {
      if (!set) {
        set = new Set<string>();
        this.mutedBySpace.set(meta.spaceId, set);
      }
      set.add(meta.userId);
    } else if (set) {
      set.delete(meta.userId);
      if (set.size === 0) this.mutedBySpace.delete(meta.spaceId);
    }

    return { userId: meta.userId, spaceId: meta.spaceId, wasActive: true, changed: true };
  }

  watch(params: { socketId: string; spaceId: string }): { prevRoomSpaceId: string | null } {
    const socketId = (params.socketId ?? '').trim();
    const spaceId = (params.spaceId ?? '').trim();
    if (!socketId || !spaceId) return { prevRoomSpaceId: null };
    const prevRoomSpaceId = this.roomSpaceBySocket.get(socketId) ?? null;
    this.roomSpaceBySocket.set(socketId, spaceId);
    return { prevRoomSpaceId };
  }

  getRoomSpaceForSocket(socketIdRaw: string): string | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;
    return this.roomSpaceBySocket.get(socketId) ?? null;
  }

  clearRoomForSocket(socketIdRaw: string): string | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;
    const prev = this.roomSpaceBySocket.get(socketId) ?? null;
    this.roomSpaceBySocket.delete(socketId);
    return prev;
  }

  leave(socketIdRaw: string): { userId: string; spaceId: string; wasActive: boolean } | null {
    const socketId = (socketIdRaw ?? '').trim();
    if (!socketId) return null;

    const meta = this.spaceBySocket.get(socketId);
    if (!meta) return null;

    this.spaceBySocket.delete(socketId);

    const current = this.currentByUser.get(meta.userId) ?? null;
    const wasActive = Boolean(current?.socketId === socketId);
    if (!wasActive) {
      return { userId: meta.userId, spaceId: meta.spaceId, wasActive: false };
    }

    this.currentByUser.delete(meta.userId);
    const set = this.usersBySpace.get(meta.spaceId);
    if (set) {
      set.delete(meta.userId);
      if (set.size === 0) this.usersBySpace.delete(meta.spaceId);
    }
    const pausedSet = this.pausedBySpace.get(meta.spaceId);
    if (pausedSet) {
      pausedSet.delete(meta.userId);
      if (pausedSet.size === 0) this.pausedBySpace.delete(meta.spaceId);
    }
    const mutedSet = this.mutedBySpace.get(meta.spaceId);
    if (mutedSet) {
      mutedSet.delete(meta.userId);
      if (mutedSet.size === 0) this.mutedBySpace.delete(meta.spaceId);
    }

    return { userId: meta.userId, spaceId: meta.spaceId, wasActive: true };
  }

  /** Used on disconnect. */
  onDisconnect(socketId: string): { userId: string; spaceId: string; wasActive: boolean } | null {
    this.roomSpaceBySocket.delete(socketId);
    return this.leave(socketId);
  }

  getMembersForSpace(spaceIdRaw: string): { userIds: string[]; pausedUserIds: string[]; mutedUserIds: string[] } {
    const spaceId = (spaceIdRaw ?? '').trim();
    if (!spaceId) return { userIds: [], pausedUserIds: [], mutedUserIds: [] };
    const set = this.usersBySpace.get(spaceId);
    if (!set) return { userIds: [], pausedUserIds: [], mutedUserIds: [] };
    const pausedSet = this.pausedBySpace.get(spaceId) ?? new Set<string>();
    const mutedSet = this.mutedBySpace.get(spaceId) ?? new Set<string>();
    const userIds = Array.from(set);
    const pausedUserIds = userIds.filter((id) => pausedSet.has(id));
    const mutedUserIds = userIds.filter((id) => mutedSet.has(id));
    return { userIds, pausedUserIds, mutedUserIds };
  }

  /**
   * Counts of users currently in each space (includes paused).
   * Always includes all configured space IDs, even if the count is 0.
   */
  getLobbyCountsBySpaceId(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const spaceId of SPACE_IDS) {
      out[spaceId] = this.usersBySpace.get(spaceId)?.size ?? 0;
    }
    return out;
  }
}

