import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SideEffectPayloads } from '../side-effects/side-effects.constants';
import { SideEffectsRegistry } from '../side-effects/side-effects.registry';
import { MarvinCannedRepliesService } from './services/marvin-canned-replies.service';

/**
 * Marv-owned side effects that run off the request path.
 *
 * Billing still owns `billing.premium.changed` (bell notification). When that
 * fires with `direction: 'started'`, billing dispatches `marv.premium.welcome`
 * so this handler can send the one-shot welcome DM without pulling Messages/Marv
 * into BillingModule.
 */
@Injectable()
export class MarvinSideEffectsHandler implements OnModuleInit {
  constructor(
    private readonly registry: SideEffectsRegistry,
    private readonly canned: MarvinCannedRepliesService,
  ) {}

  onModuleInit(): void {
    this.registry.register('marv.premium.welcome', (p) => this.onPremiumWelcome(p));
  }

  private async onPremiumWelcome(
    payload: SideEffectPayloads['marv.premium.welcome'],
  ): Promise<void> {
    await this.canned.sendPremiumWelcomeDm(payload.userId);
  }
}
