import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { AppConfigService } from '../app/app-config.service';

export type SocketMeta = { userId: string; client: string };

const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

/**
 * In-memory presence: userId -> Set of socketIds, socketId -> { userId, client }.
 * Supports grace period (show online for X min after disconnect) and targeted subscriptions.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  /** userId -> Set of socketIds */
  private readonly userSockets = new Map<string, Set<string>>();
  /** socketId -> meta (for cleanup and knowing what client type) */
  private readonly socketMeta = new Map<string, SocketMeta>();
  /** userId -> last disconnect timestamp (for grace period) */
  private readonly lastDisconnectAt = new Map<string, number>();
  /** userId -> when they last came online (for sort order; not updated on grace-reconnect) */
  private readonly lastConnectAt = new Map<string, number>();
  /** socketId -> Set of userIds this socket cares about */
  private readonly socketSubscriptions = new Map<string, Set<string>>();
  /** userId -> Set of socketIds subscribed to this user */
  private readonly userSubscribers = new Map<string, Set<string>>();
  /** socketIds that receive all online/offline events (online page viewers) */
  private readonly onlineFeedListeners = new Set<string>();
  /** userIds currently marked idle (no activity for X time); still online, shown with clock */
  private readonly idleUserIds = new Set<string>();

  constructor(private readonly appConfig: AppConfigService) {}

  graceMs(): number {
    return this.appConfig.presenceGraceMinutes() * 60 * 1000;
  }

  recentDisconnectMs(): number {
    return this.appConfig.presenceRecentDisconnectMinutes() * 60 * 1000;
  }

  idleDisconnectMs(): number {
    return this.appConfig.presenceIdleDisconnectMinutes() * 60 * 1000;
  }

  getUserIdForSocket(socketId: string): string | null {
    return this.socketMeta.get(socketId)?.userId ?? null;
  }

  setUserIdle(userId: string): void {
    this.idleUserIds.add(userId);
  }

  setUserActive(userId: string): void {
    this.idleUserIds.delete(userId);
  }

  isUserIdle(userId: string): boolean {
    return this.idleUserIds.has(userId);
  }

  isUserOnline(userId: string): boolean {
    if (this.userSockets.has(userId) && (this.userSockets.get(userId)?.size ?? 0) > 0) {
      return true;
    }
    const last = this.lastDisconnectAt.get(userId);
    if (last == null) return false;
    return Date.now() - last < this.graceMs();
  }

  /**
   * Register a socket for a user. Call from gateway after auth.
   * Clears grace period if user was in it (reconnect).
   */
  register(socketId: string, userId: string, client: string): { isNewlyOnline: boolean } {
    const wasInGrace = this.lastDisconnectAt.has(userId);
    this.lastDisconnectAt.delete(userId);

    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set<string>();
      this.userSockets.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socketId);
    this.socketMeta.set(socketId, { userId, client });
    if (wasEmpty && !wasInGrace) {
      this.lastConnectAt.set(userId, Date.now());
    }
    return { isNewlyOnline: wasEmpty };
  }

  /**
   * Force-unregister a socket (e.g. on explicit logout). Skips grace period - if this was the last
   * connection, the user is immediately offline.
   */
  forceUnregister(socketId: string): { userId: string; wasLastConnection: boolean } | null {
    this.socketSubscriptions.delete(socketId);
    this.onlineFeedListeners.delete(socketId);
    this.removeSocketFromUserSubscribers(socketId);

    const meta = this.socketMeta.get(socketId);
    if (!meta) return null;
    this.socketMeta.delete(socketId);
    this.idleUserIds.delete(meta.userId);
    const set = this.userSockets.get(meta.userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.userSockets.delete(meta.userId);
        this.clearGrace(meta.userId);
        return { userId: meta.userId, wasLastConnection: true };
      }
    }
    return { userId: meta.userId, wasLastConnection: false };
  }

  /**
   * Unregister a socket (e.g. on disconnect).
   * @returns userId and isNowOffline true if that user has no sockets left (enter grace or emit offline).
   */
  unregister(socketId: string): { userId: string; isNowOffline: boolean } | null {
    this.socketSubscriptions.delete(socketId);
    this.onlineFeedListeners.delete(socketId);
    this.removeSocketFromUserSubscribers(socketId);

    const meta = this.socketMeta.get(socketId);
    if (!meta) return null;
    this.socketMeta.delete(socketId);
    this.idleUserIds.delete(meta.userId);
    const set = this.userSockets.get(meta.userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.userSockets.delete(meta.userId);
        this.lastDisconnectAt.set(meta.userId, Date.now());
        return { userId: meta.userId, isNowOffline: true };
      }
    }
    return { userId: meta.userId, isNowOffline: false };
  }

  private removeSocketFromUserSubscribers(socketId: string): void {
    for (const [userId, subs] of this.userSubscribers) {
      subs.delete(socketId);
      if (subs.size === 0) this.userSubscribers.delete(userId);
    }
  }

  /** Clear grace for userId (call when full offline timer fires at 6 min). */
  clearGrace(userId: string): void {
    this.lastDisconnectAt.delete(userId);
    this.lastConnectAt.delete(userId);
  }

  getLastConnectAt(userId: string): number | undefined {
    return this.lastConnectAt.get(userId);
  }

  isUserRecentlyDisconnected(userId: string): boolean {
    const last = this.lastDisconnectAt.get(userId);
    if (last == null) return false;
    const elapsed = Date.now() - last;
    return elapsed >= this.graceMs() && elapsed < this.recentDisconnectMs();
  }

  getLastDisconnectAt(userId: string): number | undefined {
    return this.lastDisconnectAt.get(userId);
  }

  getDisconnectAtIfRecent(userId: string): number | undefined {
    const last = this.lastDisconnectAt.get(userId);
    if (last == null) return undefined;
    const elapsed = Date.now() - last;
    if (elapsed >= this.graceMs() && elapsed < this.recentDisconnectMs()) {
      return last;
    }
    return undefined;
  }

  getOnlineUserIds(): string[] {
    return this.getOnlineUserIdsOrderedByRecent();
  }

  /** Online user IDs sorted by most recent first (lastConnectAt desc). Users in grace keep their connect time. */
  getOnlineUserIdsOrderedByRecent(): string[] {
    const candidates: { userId: string; lastConnectAt: number }[] = [];
    const now = Date.now();
    const grace = this.graceMs();

    for (const uid of this.userSockets.keys()) {
      const t = this.lastConnectAt.get(uid) ?? now;
      candidates.push({ userId: uid, lastConnectAt: t });
    }
    for (const [uid, ts] of this.lastDisconnectAt) {
      if (now - ts < grace && !this.userSockets.has(uid)) {
        const t = this.lastConnectAt.get(uid) ?? 0;
        candidates.push({ userId: uid, lastConnectAt: t });
      }
    }
    candidates.sort((a, b) => b.lastConnectAt - a.lastConnectAt);
    return candidates.map((c) => c.userId);
  }

  subscribe(socketId: string, userIds: string[]): { added: string[] } {
    let set = this.socketSubscriptions.get(socketId);
    if (!set) {
      set = new Set<string>();
      this.socketSubscriptions.set(socketId, set);
    }
    const added: string[] = [];
    for (const uid of userIds) {
      if (set.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
        this.logger.warn(`Socket ${socketId} hit subscription cap (${MAX_SUBSCRIPTIONS_PER_SOCKET})`);
        break;
      }
      if (!set.has(uid)) {
        set.add(uid);
        added.push(uid);
        let subs = this.userSubscribers.get(uid);
        if (!subs) {
          subs = new Set<string>();
          this.userSubscribers.set(uid, subs);
        }
        subs.add(socketId);
      }
    }
    return { added };
  }

  unsubscribe(socketId: string, userIds: string[]): void {
    const set = this.socketSubscriptions.get(socketId);
    if (!set) return;
    for (const uid of userIds) {
      set.delete(uid);
      const subs = this.userSubscribers.get(uid);
      if (subs) {
        subs.delete(socketId);
        if (subs.size === 0) this.userSubscribers.delete(uid);
      }
    }
  }

  subscribeOnlineFeed(socketId: string): void {
    this.onlineFeedListeners.add(socketId);
  }

  unsubscribeOnlineFeed(socketId: string): void {
    this.onlineFeedListeners.delete(socketId);
  }

  getSubscribers(userId: string): Set<string> {
    return this.userSubscribers.get(userId) ?? new Set();
  }

  getOnlineFeedListeners(): Set<string> {
    return new Set(this.onlineFeedListeners);
  }

  /**
   * Emit to every socket for the given user (foundation for "push to user").
   */
  emitToUser(server: Server, userId: string, event: string, payload: unknown): void {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return;
    for (const id of socketIds) {
      const socket = server.sockets.sockets.get(id);
      socket?.emit(event, payload);
    }
  }

  /** For debugging / future "my devices" API: list clients for a user. */
  getClientsForUser(userId: string): string[] {
    const set = this.userSockets.get(userId);
    if (!set) return [];
    return Array.from(set).map((socketId) => this.socketMeta.get(socketId)?.client ?? 'unknown');
  }

  /** Socket IDs for a user (e.g. to disconnect them on idle timeout). */
  getSocketIdsForUser(userId: string): string[] {
    const set = this.userSockets.get(userId);
    return set ? Array.from(set) : [];
  }
}
