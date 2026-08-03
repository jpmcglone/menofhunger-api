import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

/**
 * The "someone sent you coins" notification.
 *
 * The balances themselves move inside the transfer transaction and both parties get a
 * `users:me-updated` emit on the request path, so the recipient's balance is already correct
 * before this runs — only the bell row and push are deferred.
 */
@Injectable()
export class CoinsSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('coins.transferred', (p) => this.onTransferred(p));
  }

  private async onTransferred(payload: SideEffectPayloads['coins.transferred']): Promise<void> {
    await this.notifications.create({
      recipientUserId: payload.recipientUserId,
      kind: 'coin_transfer',
      actorUserId: payload.senderUserId,
      title: `sent you ${payload.amountLabel}`,
      body: payload.note,
    });
  }
}
