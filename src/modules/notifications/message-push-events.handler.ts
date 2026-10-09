import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationPushService } from "./notification-push.service";
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
} from "@nestjs/common";
import type { Subscription } from "rxjs";
import { DomainEventsService } from "../events/domain-events.service";

@Injectable()
export class MessagePushEventsHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagePushEventsHandler.name);
  private sub: Subscription | null = null;
  private readSub: Subscription | null = null;

  constructor(
    private readonly events: DomainEventsService,
    @Inject(NotificationReadStateService)
    private readonly notificationReadStateService: Pick<
      NotificationReadStateService,
      "markConversationMessageNotificationRead"
    >,
    @Inject(NotificationPushService)
    private readonly notificationPushService: Pick<
      NotificationPushService,
      "sendMessagePush"
    >,
  ) {}

  onModuleInit(): void {
    this.readSub = this.events.onConversationRead((event) => {
      void this.notificationReadStateService
        .markConversationMessageNotificationRead({
          userId: event.userId,
          conversationId: event.conversationId,
        })
        .catch((err) => {
          this.logger.debug(
            `[notifications] Failed to clear message notification on read: ${err}`,
          );
        });
    });

    this.sub = this.events.onMessagePushRequested((event) => {
      // Chat unread state belongs to the messages badge; this handler only sends
      // external push notifications so chat does not appear in the bell feed.
      void this.notificationPushService
        .sendMessagePush({
          recipientUserId: event.recipientUserId,
          senderUserId: event.senderUserId,
          senderName: event.senderName,
          body: event.body ?? undefined,
          conversationId: event.conversationId,
          skipIfVoipRegistered: event.skipIfVoipRegistered,
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
