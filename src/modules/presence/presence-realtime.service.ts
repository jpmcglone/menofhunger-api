import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PresenceService } from './presence.service';
import type {
  AdminUpdatedPayloadDto,
  FollowsChangedPayloadDto,
  MessagesReadPayloadDto,
  NotificationsNewPayloadDto,
  PostsInteractionPayloadDto,
  UsersSelfUpdatedPayloadDto,
} from '../../common/dto';

@Injectable()
export class PresenceRealtimeService {
  private readonly logger = new Logger(PresenceRealtimeService.name);
  private server: Server | null = null;

  constructor(private readonly presence: PresenceService) {}

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

  emitNotificationsUpdated(userId: string, payload: { undeliveredCount: number }): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'notifications:updated', payload);
  }

  emitNotificationNew(userId: string, payload: NotificationsNewPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'notifications:new', payload);
  }

  emitMessagesUpdated(userId: string, payload: { primaryUnreadCount: number; requestUnreadCount: number }): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'messages:updated', payload);
  }

  emitMessagesRead(userId: string, payload: MessagesReadPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'messages:read', payload);
  }

  emitMessageCreated(userId: string, payload: { conversationId: string; message: unknown }): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'messages:new', payload);
  }

  emitFollowsChanged(userId: string, payload: FollowsChangedPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'follows:changed', payload);
  }

  emitPostsInteraction(userIds: Iterable<string>, payload: PostsInteractionPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    for (const userId of userIds) {
      if (!userId) continue;
      this.presence.emitToUser(server, userId, 'posts:interaction', payload);
    }
  }

  emitAdminUpdated(userId: string, payload: AdminUpdatedPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    this.presence.emitToUser(server, userId, 'admin:updated', payload);
  }

  emitUsersSelfUpdated(userIds: Iterable<string>, payload: UsersSelfUpdatedPayloadDto): void {
    const server = this.getServerOrNull();
    if (!server) return;
    for (const userId of userIds) {
      if (!userId) continue;
      this.presence.emitToUser(server, userId, 'users:selfUpdated', payload);
    }
  }
}

