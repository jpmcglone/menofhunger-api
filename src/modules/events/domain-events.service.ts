import { Injectable } from '@nestjs/common';
import { Subject, type Subscription } from 'rxjs';

export type MessagePushRequestedEvent = {
  recipientUserId: string;
  senderName: string;
  body?: string | null;
  conversationId: string;
};

@Injectable()
export class DomainEventsService {
  private readonly messagePushRequested$ = new Subject<MessagePushRequestedEvent>();

  emitMessagePushRequested(event: MessagePushRequestedEvent): void {
    this.messagePushRequested$.next(event);
  }

  onMessagePushRequested(handler: (event: MessagePushRequestedEvent) => void): Subscription {
    return this.messagePushRequested$.subscribe({ next: handler });
  }
}

