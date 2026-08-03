import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { SiteConfigService } from '../site-config/site-config.service';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { UserVerificationService } from './user-verification.service';

/**
 * Verification side effects: the "you're verified" notification, and the auto-verify
 * evaluation that used to run inline during signup and referral-code entry.
 *
 * Auto-verify is the expensive one — it gifts coins, records affiliate earnings, and calls
 * Stripe through the billing hooks. None of that belongs in the latency budget of a signup.
 */
@Injectable()
export class VerificationSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly userVerification: UserVerificationService,
    private readonly siteConfig: SiteConfigService,
    private readonly notifications: NotificationsService,
    private readonly registry: SideEffectsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register('user.verified', (p) => this.onVerified(p));
    this.registry.register('user.auto-verify', (p) => this.onAutoVerify(p));
  }

  private async onVerified(payload: SideEffectPayloads['user.verified']): Promise<void> {
    await this.notifications.create({
      recipientUserId: payload.userId,
      kind: 'account_verified',
      subjectUserId: payload.userId,
      title: "You're verified",
      body: 'Your account is now verified. Welcome.',
    });
  }

  private async onAutoVerify(payload: SideEffectPayloads['user.auto-verify']): Promise<void> {
    const cfg = await this.siteConfig.getUncached();
    if (!this.siteConfig.shouldAutoVerify(cfg, payload.recruitedById)) return;

    await this.userVerification.verifyUser({ userId: payload.userId, source: payload.source });
  }
}
