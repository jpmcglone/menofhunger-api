import { Injectable } from '@nestjs/common';
import { Subject, type Subscription } from 'rxjs';

export type MessagePushRequestedEvent = {
  recipientUserId: string;
  senderUserId: string;
  senderName: string;
  body?: string | null;
  conversationId: string;
  /** Set for direct-call rows: the ring already reaches iPhones through PushKit. */
  skipIfVoipRegistered?: boolean;
};

export type ConversationReadEvent = {
  userId: string;
  conversationId: string;
};

export type UserStatusSetEvent = {
  userId: string;
  text: string;
  /** ID of the `kind: 'status'` post created alongside this status (null when `createsPost` was false). */
  postId: string | null;
  /**
   * `created` — a brand-new status (PUT). Each one is its own event, so every follower
   * gets a NEW notification row pointing at that status's post (or the profile).
   * `edited` — a text edit of the active status (PATCH). Patches the existing notification
   * in place: no new row, no bell increment, no push.
   */
  mode: 'created' | 'edited';
};

@Injectable()
export class DomainEventsService {
  private readonly messagePushRequested$ = new Subject<MessagePushRequestedEvent>();
  private readonly conversationRead$ = new Subject<ConversationReadEvent>();
  private readonly userStatusSet$ = new Subject<UserStatusSetEvent>();

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

  emitUserStatusSet(event: UserStatusSetEvent): void {
    this.userStatusSet$.next(event);
  }

  onUserStatusSet(handler: (event: UserStatusSetEvent) => void): Subscription {
    return this.userStatusSet$.subscribe({ next: handler });
  }
}

