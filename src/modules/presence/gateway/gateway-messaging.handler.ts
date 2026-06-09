import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { MessagesService } from '../../messages/messages.service';
import { WsEventNames, type PostsTypingPayloadDto } from '../../../common/dto';
import { PresenceService } from '../presence.service';
import { PresenceRedisStateService } from '../presence-redis-state.service';
import { GatewayContextService } from './gateway-context.service';
import { GatewayThrottleService } from './gateway-throttle.service';
import { postRoom } from './gateway-rooms';

/** Messaging + typing indicators: chat-screen tracking, DM typing, post-composer typing. */
@Injectable()
export class MessagingGatewayHandler {
  constructor(
    private readonly presence: PresenceService,
    private readonly presenceRedis: PresenceRedisStateService,
    private readonly messages: MessagesService,
    private readonly throttle: GatewayThrottleService,
    private readonly context: GatewayContextService,
  ) {}

  handleMessagesScreen(client: Socket, payload: { active?: boolean; conversationId?: string }): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const active = payload?.active !== false;
    this.presence.setChatScreenActive(client.id, active);
    const convId = active && payload?.conversationId ? payload.conversationId : null;
    this.presence.setActiveConversation(client.id, convId);
  }

  async handleMessagesTyping(
    client: Socket,
    payload: { conversationId?: string; typing?: boolean },
  ): Promise<void> {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const conversationId = String(payload?.conversationId ?? '').trim();
    if (!conversationId) return;
    const typing = payload?.typing !== false;

    if (!this.throttle.shouldEmitTyping(`${userId}:${conversationId}:${typing ? '1' : '0'}`, 700)) return;

    let participantIds: string[] = [];
    try {
      participantIds = await this.messages.listConversationParticipantUserIds({ userId, conversationId });
    } catch {
      return;
    }

    for (const id of participantIds) {
      if (!id || id === userId) continue;
      const targetSockets = this.presence.getChatScreenSocketIdsForUser(id);
      if (targetSockets.length === 0) continue;
      this.context.emitToSockets(targetSockets, 'messages:typing', {
        conversationId,
        userId,
        typing,
      });
    }
  }

  handlePostsTyping(client: Socket, payload: { postId?: string; typing?: boolean }): void {
    const userId = this.presence.getUserIdForSocket(client.id);
    if (!userId) return;
    const postId = String(payload?.postId ?? '').trim();
    if (!postId) return;

    // Only broadcast to clients that have subscribed to this post room.
    if (!(client.data as any).postSubs?.has(postId)) return;

    const typing = payload?.typing !== false;
    if (!this.throttle.shouldEmitTyping(`posts:${userId}:${postId}:${typing ? '1' : '0'}`, 700)) return;

    // Reuse the user data stored on the socket during connection — no DB call needed.
    const sender = ((client.data as any)?.spaceChatUser ?? null) as { id: string; username: string | null; verifiedStatus: string; premium: boolean; premiumPlus: boolean; isOrganization: boolean } | null;
    if (!sender?.id) return;

    const room = postRoom(postId);
    const out: PostsTypingPayloadDto = {
      postId,
      user: {
        id: sender.id,
        username: sender.username,
        verifiedStatus: sender.verifiedStatus ?? null,
        premium: Boolean(sender.premium),
        premiumPlus: Boolean(sender.premiumPlus),
        isOrganization: Boolean(sender.isOrganization),
      },
      typing,
    };
    // client.to() skips the sender's socket.
    client.to(room).emit(WsEventNames.postsTyping, out);
    void this.presenceRedis.publishEmitToRoom({ room, event: WsEventNames.postsTyping, payload: out }).catch(() => undefined);
  }
}
