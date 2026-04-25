import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DomainEventsService } from '../events/domain-events.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class MessagePushEventsHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagePushEventsHandler.name);
  private sub: Subscription | null = null;
  private readSub: Subscription | null = null;

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.readSub = this.events.onConversationRead((event) => {
      void this.notifications
        .markConversationMessageNotificationRead({
          userId: event.userId,
          conversationId: event.conversationId,
        })
        .catch((err) => {
          this.logger.debug(`[notifications] Failed to clear message notification on read: ${err}`);
        });
    });

    this.sub = this.events.onMessagePushRequested((event) => {
      // Chat unread state belongs to the messages badge; this handler only sends
      // external push notifications so chat does not appear in the bell feed.
      void this.notifications
        .sendMessagePush({
          recipientUserId: event.recipientUserId,
          senderUserId: event.senderUserId,
          senderName: event.senderName,
          body: event.body ?? undefined,
          conversationId: event.conversationId,
        })
        .catch((err) => {
          this.logger.debug(`[push] Message push handler failed: ${err}`);
        });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.sub = null;
    this.readSub?.unsubscribe();
    this.readSub = null;
  }
}

