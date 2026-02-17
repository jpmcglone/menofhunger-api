import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DomainEventsService } from '../events/domain-events.service';
import { NotificationsEmailCron } from './notifications-email.cron';

@Injectable()
export class MessageInstantEmailEventsHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageInstantEmailEventsHandler.name);
  private sub: Subscription | null = null;

  constructor(
    private readonly events: DomainEventsService,
    private readonly emails: NotificationsEmailCron,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.onMessagePushRequested((event) => {
      // Best-effort: enqueue a batched "high signal" email for the recipient.
      void this.emails.enqueueInstantHighSignalEmail(event.recipientUserId).catch((err) => {
        this.logger.debug(`[email] Message instant email handler failed: ${err}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.sub = null;
  }
}

