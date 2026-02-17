import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PresenceService } from './presence.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import type {
  AdminUpdatedPayloadDto,
  FollowsChangedPayloadDto,
  MessagesReadPayloadDto,
  UsersMeUpdatedPayloadDto,
  NotificationsDeletedPayloadDto,
  NotificationsNewPayloadDto,
  PostsInteractionPayloadDto,
  UsersSelfUpdatedPayloadDto,
} from '../../common/dto';

@Injectable()
export class PresenceRealtimeService {
  private readonly logger = new Logger(PresenceRealtimeService.name);
  private server: Server | null = null;

  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
  ) {}

  /**
   * Called by PresenceGateway once Socket.IO is initialized.
   * Safe to call multiple times (e.g. dev HMR/restart).
   */
  setServer(server: Server): void {
    this.server = server;
  }

  private getServerOrNull(): Server | null {
    if (this.server) return this.server;
    // This can happen during startup or tests; do not crash background work.
    this.logger.debug('[presence] Socket server not initialized; dropping realtime emit.');
    return null;
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    const server = this.getServerOrNull();
    if (!server) return;
    const uid = (userId ?? '').trim();
    const ev = (event ?? '').trim();
    if (!uid || !ev) return;

    // Local delivery (fast path).
    this.presence.emitToUser(server, uid, ev, payload);
    // Cross-instance delivery (best-effort).
    void this.presenceRedis.publishEmitToUser({ userId: uid, event: ev, payload }).catch(() => undefined);
  }

  private emitToUsers(userIds: Iterable<string>, event: string, payload: unknown): void {
    for (const userId of userIds) {
      if (!userId) continue;
      this.emitToUser(userId, event, payload);
    }
  }

  disconnectUserSockets(userId: string): void {
    const server = this.getServerOrNull();
    if (!server) return;
    const ids = this.presence.getSocketIdsForUser(userId);
    for (const id of ids) {
      try {
        server.sockets.sockets.get(id)?.disconnect(true);
      } catch {
        // ignore
      }
    }
  }

  emitNotificationsUpdated(userId: string, payload: { undeliveredCount: number }): void {
    this.emitToUser(userId, 'notifications:updated', payload);
  }

  emitNotificationNew(userId: string, payload: NotificationsNewPayloadDto): void {
    this.emitToUser(userId, 'notifications:new', payload);
  }

  emitNotificationsDeleted(userId: string, payload: NotificationsDeletedPayloadDto): void {
    this.emitToUser(userId, 'notifications:deleted', payload);
  }

  emitMessagesUpdated(userId: string, payload: { primaryUnreadCount: number; requestUnreadCount: number }): void {
    this.emitToUser(userId, 'messages:updated', payload);
  }

  emitMessagesRead(userId: string, payload: MessagesReadPayloadDto): void {
    this.emitToUser(userId, 'messages:read', payload);
  }

  emitMessageCreated(userId: string, payload: { conversationId: string; message: unknown }): void {
    this.emitToUser(userId, 'messages:new', payload);
  }

  emitFollowsChanged(userId: string, payload: FollowsChangedPayloadDto): void {
    this.emitToUser(userId, 'follows:changed', payload);
  }

  emitPostsInteraction(userIds: Iterable<string>, payload: PostsInteractionPayloadDto): void {
    this.emitToUsers(userIds, 'posts:interaction', payload);
  }

  emitAdminUpdated(userId: string, payload: AdminUpdatedPayloadDto): void {
    this.emitToUser(userId, 'admin:updated', payload);
  }

  emitUsersSelfUpdated(userIds: Iterable<string>, payload: UsersSelfUpdatedPayloadDto): void {
    this.emitToUsers(userIds, 'users:selfUpdated', payload);
  }

  /** Self-only auth/settings updates (never broadcast beyond the user's sockets). */
  emitUsersMeUpdated(userId: string, payload: UsersMeUpdatedPayloadDto): void {
    this.emitToUser(userId, 'users:meUpdated', payload);
  }
}

