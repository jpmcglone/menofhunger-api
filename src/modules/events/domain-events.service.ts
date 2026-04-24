import { Injectable } from '@nestjs/common';
import { Subject, type Subscription } from 'rxjs';

export type MessagePushRequestedEvent = {
  recipientUserId: string;
  senderUserId: string;
  senderName: string;
  body?: string | null;
  conversationId: string;
};

export type ConversationReadEvent = {
  userId: string;
  conversationId: string;
};

@Injectable()
export class DomainEventsService {
  private readonly messagePushRequested$ = new Subject<MessagePushRequestedEvent>();
  private readonly conversationRead$ = new Subject<ConversationReadEvent>();

  emitMessagePushRequested(event: MessagePushRequestedEvent): void {
    this.messagePushRequested$.next(event);
  }

  onMessagePushRequested(handler: (event: MessagePushRequestedEvent) => void): Subscription {
    return this.messagePushRequested$.subscribe({ next: handler });
  }

  emitConversationRead(event: ConversationReadEvent): void {
    this.conversationRead$.next(event);
  }

  onConversationRead(handler: (event: ConversationReadEvent) => void): Subscription {
    return this.conversationRead$.subscribe({ next: handler });
  }
}

