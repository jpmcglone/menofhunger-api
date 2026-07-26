import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { DomainEventsService } from '../events/domain-events.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class StatusNotificationEventsHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusNotificationEventsHandler.name);
  private sub: Subscription | null = null;

  constructor(
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.sub = this.events.onUserStatusSet((event) => {
      void this.notifications
        .fanOutStatusUpdateNotifications({ actorUserId: event.userId, text: event.text })
        .catch((err) => {
          this.logger.warn(
            `[notifications] Status fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    this.sub = null;
  }
}
