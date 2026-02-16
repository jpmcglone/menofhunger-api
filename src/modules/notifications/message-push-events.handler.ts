import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DomainEventsService } from '../events/domain-events.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class MessagePushEventsHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagePushEventsHandler.name);
  private sub: Subscription | null = null;

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.onMessagePushRequested((event) => {
      void this.notifications
        .sendMessagePush({
          recipientUserId: event.recipientUserId,
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
  }
}

