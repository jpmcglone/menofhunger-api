import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';

/**
 * Billing side effects: sends a bell notification when the user's premium access
 * crosses the none <-> premium boundary.
 *
 * The handler re-reads current DB state before writing so a delayed retry is safe:
 * if the DB already reflects the *opposite* of `direction`, the write is skipped.
 */
@Injectable()
export class BillingSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('billing.premium.changed', (p) => this.onPremiumChanged(p));
  }

  private async onPremiumChanged(
    payload: SideEffectPayloads['billing.premium.changed'],
  ): Promise<void> {
    const { userId, direction } = payload;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true },
    });
    if (!user) return;

    // Idempotency guard: skip if current state contradicts the direction.
    // e.g. direction='started' but user.premium is now false means the user
    // has already lost premium again — don't send a stale "you're premium" bell.
    if (direction === 'started' && !user.premium) return;
    if (direction === 'ended' && user.premium) return;

    await this.notifications.upsertPremiumStatusNotification({
      recipientUserId: userId,
      kind: direction === 'started' ? 'premium_started' : 'premium_ended',
      isPremiumPlus: user.premiumPlus,
    });
  }
}
