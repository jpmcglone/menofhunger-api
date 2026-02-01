import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { AUTH_COOKIE_NAME } from '../auth/auth.constants';
import { PresenceService } from './presence.service';
import { FollowsService } from '../follows/follows.service';
import type { FollowListUser } from '../follows/follows.service';

function parseSessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader?.trim()) return undefined;
  const parts = cookieHeader.split(';').map((s) => s.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === AUTH_COOKIE_NAME) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

type UserTimers = {
  graceTimer?: ReturnType<typeof setTimeout>;
  offlineTimer?: ReturnType<typeof setTimeout>;
  idleDisconnectTimer?: ReturnType<typeof setTimeout>;
};

@WebSocketGateway({
  path: '/socket.io',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class PresenceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(PresenceGateway.name);
  private readonly userTimers = new Map<string, UserTimers>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
    private readonly follows: FollowsService,
  ) {}

  async handleConnection(client: import('socket.io').Socket): Promise<void> {
    const cookieHeader = client.handshake.headers.cookie as string | undefined;
    const token = parseSessionTokenFromCookie(cookieHeader);
    const user = await this.auth.meFromSessionToken(token);
    if (!user) {
      this.logger.debug(`Presence connection rejected: no session for socket ${client.id}`);
      client.disconnect(true);
      return;
    }

    this.cancelUserTimers(user.id);
    this.presence.clearGrace(user.id);

    const clientType =
      (Array.isArray(client.handshake.query.client)
        ? client.handshake.query.client[0]
        : client.handshake.query.client) ?? 'web';

    const { isNewlyOnline } = this.presence.register(client.id, user.id, String(clientType));
    this.logger.log(`[presence] CONNECT socket=${client.id} userId=${user.id} isNewlyOnline=${isNewlyOnline}`);

    client.emit('presence:init', {});

    if (isNewlyOnline) {
      await this.emitOnline(user.id);
    }
  }

  handleDisconnect(client: import('socket.io').Socket): void {
    const result = this.presence.unregister(client.id);
    this.logger.log(`[presence] DISCONNECT socket=${client.id} userId=${result?.userId ?? '?'} isNowOffline=${result?.isNowOffline ?? false}`);
    if (result?.isNowOffline) {
      this.scheduleGraceTimer(result.userId);
    }
  }

  private cancelUserTimers(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers) {
      if (timers.graceTimer) clearTimeout(timers.graceTimer);
      if (timers.offlineTimer) clearTimeout(timers.offlineTimer);
      if (timers.idleDisconnectTimer) clearTimeout(timers.idleDisconnectTimer);
      this.userTimers.delete(userId);
    }
  }

  private scheduleGraceTimer(userId: string): void {
    this.cancelUserTimers(userId);
    const graceMs = this.presence.graceMs();
    const recentMs = this.presence.recentDisconnectMs();

    const graceTimer = setTimeout(() => {
      this.userTimers.delete(userId);

      const disconnectAt = this.presence.getLastDisconnectAt(userId) ?? Date.now() - graceMs;
      this.emitRecentlyDisconnected(userId, disconnectAt);

      const remainingMs = recentMs - graceMs;
      const offlineTimer = setTimeout(() => {
        this.userTimers.delete(userId);
        this.presence.clearGrace(userId);
        this.emitOffline(userId);
      }, remainingMs);
      this.userTimers.set(userId, { offlineTimer });
    }, graceMs);

    this.userTimers.set(userId, { graceTimer });
  }

  private emitToSockets(socketIds: Iterable<string>, event: string, payload: unknown): void {
    const ids = [...socketIds];
    this.logger.log(`[presence] EMIT_OUT event=${event} to ${ids.length} sockets: [${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}] payload=${JSON.stringify(payload)}`);
    for (const id of ids) {
      const socket = this.server.sockets.sockets.get(id);
      socket?.emit(event, payload);
    }
  }

  private async emitOnline(userId: string): Promise<void> {
    const subs = this.presence.getSubscribers(userId);
    const feedListeners = this.presence.getOnlineFeedListeners();
    const allTargets = new Set([...subs, ...feedListeners]);
    this.logger.log(`[presence] emitOnline userId=${userId} subs=${subs.size} feedListeners=${feedListeners.size} totalTargets=${allTargets.size}`);
    if (allTargets.size === 0) return;

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
    const subs = this.presence.getSubscribers(userId);
    const feedListeners = this.presence.getOnlineFeedListeners();
    const allTargets = new Set([...subs, ...feedListeners]);
    if (allTargets.size === 0) return;
    this.emitToSockets(allTargets, 'presence:idle', { userId });
  }

  private emitActive(userId: string): void {
    const subs = this.presence.getSubscribers(userId);
    const feedListeners = this.presence.getOnlineFeedListeners();
    const allTargets = new Set([...subs, ...feedListeners]);
    if (allTargets.size === 0) return;
    this.emitToSockets(allTargets, 'presence:active', { userId });
  }

  private emitRecentlyDisconnected(userId: string, disconnectAt: number): void {
    const subs = this.presence.getSubscribers(userId);
    const feedListeners = this.presence.getOnlineFeedListeners();
    const allTargets = new Set([...subs, ...feedListeners]);
    if (allTargets.size === 0) return;
    this.emitToSockets(allTargets, 'presence:recentlyDisconnected', { userId, disconnectAt });
  }

  private emitOffline(userId: string): void {
    const subs = this.presence.getSubscribers(userId);
    const feedListeners = this.presence.getOnlineFeedListeners();
    const allTargets = new Set([...subs, ...feedListeners]);
    if (allTargets.size === 0) return;
    this.emitToSockets(allTargets, 'presence:offline', { userId });
  }

  @SubscribeMessage('presence:subscribe')
  async handleSubscribe(
    client: import('socket.io').Socket,
    payload: { userIds?: string[] },
  ): Promise<void> {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    this.logger.log(`[presence] SUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    if (userIds.length === 0) return;
    const { added } = this.presence.subscribe(client.id, userIds);
    if (added.length > 0) {
      const users = added.map((uid) => {
        const online = this.presence.isUserOnline(uid);
        const disconnectAt = !online ? this.presence.getDisconnectAtIfRecent(uid) : undefined;
        const idle = online ? this.presence.isUserIdle(uid) : false;
        return { userId: uid, online, idle, ...(disconnectAt != null ? { disconnectAt } : {}) };
      });
      client.emit('presence:subscribed', { users });
    }
  }

  @SubscribeMessage('presence:unsubscribe')
  handleUnsubscribe(client: import('socket.io').Socket, payload: { userIds?: string[] }): void {
    const userIds = Array.isArray(payload?.userIds) ? payload.userIds : [];
    this.logger.log(`[presence] UNSUBSCRIBE_IN socket=${client.id} userIds=[${userIds.join(', ')}]`);
    if (userIds.length > 0) {
      this.presence.unsubscribe(client.id, userIds);
    }
  }

  @SubscribeMessage('presence:subscribeOnlineFeed')
  async handleSubscribeOnlineFeed(client: import('socket.io').Socket): Promise<void> {
    this.presence.subscribeOnlineFeed(client.id);
    this.logger.log(`[presence] SUBSCRIBE_ONLINE_FEED_IN socket=${client.id} feedListeners=${this.presence.getOnlineFeedListeners().size}`);

    // Send snapshot of currently online users to avoid race: User B connected before User A subscribed.
    const userIds = this.presence.getOnlineUserIds();
    if (userIds.length === 0) return;
    try {
      const users = await this.follows.getFollowListUsersByIds({
        viewerUserId: null,
        userIds,
      });
      const lastConnectAtById = new Map(userIds.map((id) => [id, this.presence.getLastConnectAt(id) ?? 0]));
      const idleById = new Map(userIds.map((id) => [id, this.presence.isUserIdle(id)]));
      const payload = users.map((u) => ({
        ...u,
        lastConnectAt: lastConnectAtById.get(u.id),
        idle: idleById.get(u.id) ?? false,
      }));
      client.emit('presence:onlineFeedSnapshot', { users: payload, totalOnline: userIds.length });
      this.logger.log(`[presence] EMIT_OUT presence:onlineFeedSnapshot to socket=${client.id} users=${userIds.length}`);
    } catch (err) {
      this.logger.warn(`[presence] Failed to send onlineFeedSnapshot: ${err}`);
    }
  }

  @SubscribeMessage('presence:unsubscribeOnlineFeed')
  handleUnsubscribeOnlineFeed(client: import('socket.io').Socket): void {
    this.logger.log(`[presence] UNSUBSCRIBE_ONLINE_FEED_IN socket=${client.id}`);
    this.presence.unsubscribeOnlineFeed(client.id);
  }

  @SubscribeMessage('presence:logout')
  handleLogout(client: import('socket.io').Socket): void {
    const result = this.presence.forceUnregister(client.id);
    if (result?.wasLastConnection) {
      this.emitOffline(result.userId);
    }
  }

  @SubscribeMessage('presence:idle')
  handleIdle(client: import('socket.io').Socket): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setUserIdle(userId);
    this.logger.log(`[presence] IDLE userId=${userId}`);
    this.emitIdle(userId);
    this.scheduleIdleDisconnectTimer(userId);
  }

  @SubscribeMessage('presence:active')
  handleActive(client: import('socket.io').Socket): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    this.presence.setUserActive(userId);
    this.logger.log(`[presence] ACTIVE userId=${userId}`);
    this.emitActive(userId);
    this.cancelIdleDisconnectTimer(userId);
  }

  private cancelIdleDisconnectTimer(userId: string): void {
    const timers = this.userTimers.get(userId);
    if (timers?.idleDisconnectTimer) {
      clearTimeout(timers.idleDisconnectTimer);
      const next = { ...timers, idleDisconnectTimer: undefined };
      if (next.graceTimer ?? next.offlineTimer) {
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
