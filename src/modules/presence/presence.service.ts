import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export type SocketMeta = { userId: string; client: string };

const MAX_SUBSCRIPTIONS_PER_SOCKET = 100;

/**
 * In-memory presence: userId -> Set of socketIds, socketId -> { userId, client }.
 * No grace period: if no connected clients, user is offline immediately.
 * Idle = no activity ping for presenceIdleAfterMinutes (default 3).
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  /** userId -> Set of socketIds */
  private readonly userSockets = new Map<string, Set<string>>();
  /** socketId -> meta (for cleanup and knowing what client type) */
  private readonly socketMeta = new Map<string, SocketMeta>();
  /** userId -> when they last came online (for sort order) */
  private readonly lastConnectAt = new Map<string, number>();
  /** userId -> last activity ping (presence:active); used to mark idle after N min */
  private readonly lastActivityAt = new Map<string, number>();
  /** socketId -> Set of userIds this socket cares about */
  private readonly socketSubscriptions = new Map<string, Set<string>>();
  /** userId -> Set of socketIds subscribed to this user */
  private readonly userSubscribers = new Map<string, Set<string>>();
  /** socketIds that receive all online/offline events (online page viewers) */
  private readonly onlineFeedListeners = new Set<string>();
  /** socketIds that are currently on chat screens */
  private readonly chatScreenListeners = new Set<string>();
  /** userIds currently marked idle (no activity for X time); still online, shown with clock */
  private readonly idleUserIds = new Set<string>();

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Minutes of no activity before marking user idle. */
  presenceIdleAfterMinutes(): number {
    return this.appConfig.presenceIdleAfterMinutes();
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

  /** Update last activity time (call on presence:active or connect). Resets idle timer. */
  setLastActivity(userId: string): void {
    this.lastActivityAt.set(userId, Date.now());
  }

  getLastActivity(userId: string): number | undefined {
    return this.lastActivityAt.get(userId);
  }

  isUserIdle(userId: string): boolean {
    return this.idleUserIds.has(userId);
  }

  /** Online only if at least one connected socket. No grace period. */
  isUserOnline(userId: string): boolean {
    const set = this.userSockets.get(userId);
    return (set?.size ?? 0) > 0;
  }

  /**
   * Register a socket for a user. Call from gateway after auth.
   */
  register(socketId: string, userId: string, client: string): { isNewlyOnline: boolean } {
    this.setLastActivity(userId);

    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set<string>();
      this.userSockets.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socketId);
    this.socketMeta.set(socketId, { userId, client });
    if (wasEmpty) {
      this.lastConnectAt.set(userId, Date.now());
    }
    return { isNewlyOnline: wasEmpty };
  }

  /**
   * Force-unregister a socket (e.g. on explicit logout). If last connection, user is immediately offline.
   */
  forceUnregister(socketId: string): { userId: string; wasLastConnection: boolean } | null {
    this.socketSubscriptions.delete(socketId);
    this.onlineFeedListeners.delete(socketId);
    this.chatScreenListeners.delete(socketId);
    this.removeSocketFromUserSubscribers(socketId);

    const meta = this.socketMeta.get(socketId);
    if (!meta) return null;
    this.socketMeta.delete(socketId);
    this.idleUserIds.delete(meta.userId);
    this.lastActivityAt.delete(meta.userId);
    const set = this.userSockets.get(meta.userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.persistLastOnlineAt(meta.userId);
        this.userSockets.delete(meta.userId);
        this.lastConnectAt.delete(meta.userId);
        this.lastActivityAt.delete(meta.userId);
        return { userId: meta.userId, wasLastConnection: true };
      }
    }
    return { userId: meta.userId, wasLastConnection: false };
  }

  /**
   * Unregister a socket (e.g. on disconnect). If no sockets left, user is immediately offline.
   */
  unregister(socketId: string): { userId: string; isNowOffline: boolean } | null {
    this.socketSubscriptions.delete(socketId);
    this.onlineFeedListeners.delete(socketId);
    this.chatScreenListeners.delete(socketId);
    this.removeSocketFromUserSubscribers(socketId);

    const meta = this.socketMeta.get(socketId);
    if (!meta) return null;
    this.socketMeta.delete(socketId);
    this.idleUserIds.delete(meta.userId);
    this.lastActivityAt.delete(meta.userId);
    const set = this.userSockets.get(meta.userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.persistLastOnlineAt(meta.userId);
        this.userSockets.delete(meta.userId);
        this.lastConnectAt.delete(meta.userId);
        return { userId: meta.userId, isNowOffline: true };
      }
    }
    return { userId: meta.userId, isNowOffline: false };
  }

  /** Persist last-online as the moment the user disconnected (when their last socket is removed). */
  private persistLastOnlineAt(userId: string): void {
    // Fire-and-forget: presence disconnect should never block gateway cleanup.
    void this.prisma.user
      .update({
        where: { id: userId },
        data: { lastOnlineAt: new Date() },
        select: { id: true },
      })
      .catch((err) => {
        this.logger.warn(`[presence] Failed to persist lastOnlineAt userId=${userId}: ${err}`);
      });
  }

  private removeSocketFromUserSubscribers(socketId: string): void {
    for (const [userId, subs] of this.userSubscribers) {
      subs.delete(socketId);
      if (subs.size === 0) this.userSubscribers.delete(userId);
    }
  }

  getLastConnectAt(userId: string): number | undefined {
    return this.lastConnectAt.get(userId);
  }

  getOnlineUserIds(): string[] {
    return this.getOnlineUserIdsOrderedByRecent();
  }

  /** Online user IDs sorted by most recent first (lastConnectAt desc). */
  getOnlineUserIdsOrderedByRecent(): string[] {
    const candidates: { userId: string; lastConnectAt: number }[] = [];
    const now = Date.now();
    for (const uid of this.userSockets.keys()) {
      const t = this.lastConnectAt.get(uid) ?? now;
      candidates.push({ userId: uid, lastConnectAt: t });
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

  setChatScreenActive(socketId: string, active: boolean): void {
    if (active) this.chatScreenListeners.add(socketId);
    else this.chatScreenListeners.delete(socketId);
  }

  isChatScreenListener(socketId: string): boolean {
    return this.chatScreenListeners.has(socketId);
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

  getChatScreenSocketIdsForUser(userId: string): string[] {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return [];
    return Array.from(socketIds).filter((id) => this.chatScreenListeners.has(id));
  }
}
