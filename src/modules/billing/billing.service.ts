import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import type { BillingCheckoutSessionDto, BillingMeDto, BillingPortalSessionDto, BillingTier } from '../../common/dto';
import type { VerifiedStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { publicAssetUrl } from '../../common/assets/public-asset-url';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../users/users-public-realtime.service';
import { PosthogService } from '../../common/posthog/posthog.service';
import { SlackService } from '../../common/slack/slack.service';
import { EntitlementService, laterDate } from './entitlement.service';
import { ReferralService } from './referral.service';

type StripeCtx = { stripe: Stripe; cfg: NonNullable<ReturnType<AppConfigService['stripe']>> };

function isVerified(status: VerifiedStatus | string | null | undefined): boolean {
  return Boolean(status && status !== 'none');
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly posthog: PosthogService,
    private readonly slack: SlackService,
    private readonly entitlement: EntitlementService,
    private readonly referral: ReferralService,
  ) {}

  private getStripe(): StripeCtx {
    const cfg = this.appConfig.stripe();
    if (!cfg) throw new ServiceUnavailableException('Billing is not configured.');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const StripeCtor = require('stripe');
    const stripe = new StripeCtor(cfg.secretKey, {
      apiVersion: '2024-06-20',
      typescript: true,
    }) as unknown as Stripe;
    return { stripe, cfg };
  }

  async getMe(userId: string): Promise<BillingMeDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        premium: true,
        premiumPlus: true,
        verifiedStatus: true,
        stripeSubscriptionStatus: true,
        stripeCancelAtPeriodEnd: true,
        stripeCurrentPeriodEnd: true,
        referralCode: true,
        referralBonusGrantedAt: true,
        recruitedBy: {
          select: {
            id: true,
            username: true,
            name: true,
            avatarKey: true,
            avatarUpdatedAt: true,
            premium: true,
            premiumPlus: true,
            verifiedStatus: true,
          },
        },
        _count: { select: { recruits: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    const activeGrants = await this.entitlement.getActiveGrants(userId);
    const grantExpiresAt = activeGrants.length > 0 ? activeGrants[0]!.endsAt : null;
    const stripeExpiresAt = user.stripeCurrentPeriodEnd ?? null;
    const effectiveExpiresAt = laterDate(stripeExpiresAt, grantExpiresAt);

    return {
      premium: Boolean(user.premium),
      premiumPlus: Boolean(user.premiumPlus),
      verified: isVerified(user.verifiedStatus),
      subscriptionStatus: user.stripeSubscriptionStatus ?? null,
      cancelAtPeriodEnd: Boolean(user.stripeCancelAtPeriodEnd),
      currentPeriodEnd: user.stripeCurrentPeriodEnd ? user.stripeCurrentPeriodEnd.toISOString() : null,
      effectiveExpiresAt: effectiveExpiresAt ? effectiveExpiresAt.toISOString() : null,
      grants: activeGrants.map((g) => ({
        id: g.id,
        tier: g.tier,
        source: g.source,
        months: g.months,
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt.toISOString(),
        reason: g.reason,
      })),
      referralCode: user.referralCode ?? null,
      recruiter: user.recruitedBy
        ? {
            id: user.recruitedBy.id,
            username: user.recruitedBy.username ?? null,
            name: user.recruitedBy.name ?? null,
            avatarUrl: publicAssetUrl({
              publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
              key: user.recruitedBy.avatarKey ?? null,
              updatedAt: user.recruitedBy.avatarUpdatedAt ?? null,
            }),
            premium: Boolean(user.recruitedBy.premium),
            premiumPlus: Boolean(user.recruitedBy.premiumPlus),
            verifiedStatus: (user.recruitedBy.verifiedStatus ?? 'none') as 'none' | 'identity' | 'manual',
          }
        : null,
      recruitCount: user._count.recruits,
      referralBonusGranted: user.referralBonusGrantedAt !== null,
    };
  }

  private async requireVerifiedUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
        stripeCustomerId: true,
      },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!isVerified(user.verifiedStatus)) {
      throw new ForbiddenException('Verify your account to subscribe to Premium.');
    }
    return user;
  }

  /**
   * Call after a user's verifiedStatus is set to a non-'none' value.
   * - Extends banked grant time by the unverified window so the user doesn't lose months.
   * - Resumes their Stripe subscription if it was paused during unverification.
   * - Re-syncs the Stripe trial window to any remaining active grants.
   * - Recomputes their effective premium tier.
   *
   * Pass previousUnverifiedAt (read before clearing it in the DB) so the extension is accurate.
   */
  async onUserVerified(userId: string, previousUnverifiedAt: Date | null): Promise<void> {
    await this.entitlement.extendGrantsAfterPause(userId, previousUnverifiedAt);

    // Resume Stripe subscription if it was paused during unverification (best-effort).
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { stripeSubscriptionId: true },
      });
      if (user?.stripeSubscriptionId) {
        const { stripe } = this.getStripe();
        const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        if (sub.pause_collection) {
          await stripe.subscriptions.update(user.stripeSubscriptionId, { pause_collection: '' });
          this.logger.log(`[billing] Resumed Stripe subscription for user ${userId}`);
        }
      }
    } catch (err) {
      this.logger.warn(`[billing] Could not resume Stripe subscription for user ${userId}: ${err}`);
    }

    // Re-sync grant trial window — grants may have been extended by the unverified pause.
    await this.syncGrantTrialToSubscription(userId);

    const result = await this.entitlement.recomputeAndApply(userId);
    this.posthog.capture(userId, 'user_verified', {
      is_premium: result.isPremium,
      is_premium_plus: result.isPremiumPlus,
      effective_tier: result.effectiveTier,
      grant_expires_at: result.grantExpiresAt?.toISOString() ?? null,
      stripe_expires_at: result.stripeExpiresAt?.toISOString() ?? null,
      extended_grants_from: previousUnverifiedAt?.toISOString() ?? null,
    });
  }

  /**
   * Syncs the Stripe subscription's trial window to align with the user's active grants.
   *
   * If the user has active grants:
   *   - Sets trial_end on the Stripe subscription to the latest grant endsAt so Stripe
   *     won't charge until the free period runs out.
   * If there are no active grants but the subscription is still trialing (e.g. grants
   * were just cleared by an admin):
   *   - Ends the trial immediately so billing resumes without waiting.
   * If the subscription is already active with no grants:
   *   - No-op; billing is already running on schedule.
   *
   * Uses proration_behavior: 'none' so no credits or refunds are issued when a trial
   * is applied mid-period — the user's existing payment stands, future charges are
   * simply deferred.
   *
   * Always best-effort — never throws.
   */
  async syncGrantTrialToSubscription(userId: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { stripeSubscriptionId: true, stripeSubscriptionStatus: true },
      });

      const subId = user?.stripeSubscriptionId;
      const status = user?.stripeSubscriptionStatus ?? '';
      if (!subId || !['active', 'trialing'].includes(status)) return;

      const { stripe } = this.getStripe();
      const activeGrants = await this.entitlement.getActiveGrants(userId);
      const latestGrantEnd = activeGrants[0]?.endsAt ?? null;

      if (latestGrantEnd && latestGrantEnd > new Date()) {
        // Defer next Stripe charge until the grant window closes.
        await stripe.subscriptions.update(subId, {
          trial_end: Math.floor(latestGrantEnd.getTime() / 1000),
          proration_behavior: 'none',
        });
        this.logger.log(`[billing] Grant trial set for user ${userId} until ${latestGrantEnd.toISOString()}`);
      } else if (status === 'trialing') {
        // Grants are gone but the sub is still in trial — end it now so Stripe charges.
        await stripe.subscriptions.update(subId, { trial_end: 'now' });
        this.logger.log(`[billing] Grant trial ended early for user ${userId} — no active grants`);
      }
      // status === 'active' with no grants: billing is already running, nothing to do.
    } catch (err) {
      this.logger.warn(`[billing] Could not sync grant trial for user ${userId}: ${err}`);
    }
  }

  /**
   * Call after a user's verifiedStatus is set to 'none'.
   * - Pauses their Stripe subscription so they aren't billed while unverified.
   * - Recomputes their effective premium tier (grants and Stripe both require verification).
   */
  async onUserUnverified(userId: string): Promise<void> {
    // Snapshot premium state before changes so we know what was lost.
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true, stripeSubscriptionId: true },
    });

    // Pause Stripe subscription (best-effort — graceful if Stripe is not configured).
    let stripePaused = false;
    try {
      if (before?.stripeSubscriptionId) {
        const { stripe } = this.getStripe();
        await stripe.subscriptions.update(before.stripeSubscriptionId, {
          pause_collection: { behavior: 'void' },
        });
        stripePaused = true;
        this.logger.log(`[billing] Paused Stripe subscription for user ${userId}`);
      }
    } catch (err) {
      this.logger.warn(`[billing] Could not pause Stripe subscription for user ${userId}: ${err}`);
    }

    await this.entitlement.recomputeAndApply(userId);
    this.posthog.capture(userId, 'user_unverified', {
      had_premium: before?.premium ?? false,
      had_premium_plus: before?.premiumPlus ?? false,
      stripe_subscription_paused: stripePaused,
    });
  }

  async createCheckoutSession(params: { userId: string; tier: BillingTier }): Promise<BillingCheckoutSessionDto> {
    const { stripe, cfg } = this.getStripe();
    const user = await this.requireVerifiedUser(params.userId);

    const price =
      params.tier === 'premiumPlus' ? cfg.pricePremiumPlusMonthly : cfg.pricePremiumMonthly;

    let stripeCustomerId = user.stripeCustomerId ?? null;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId },
      });
    }

    // Convert banked grant time to a Stripe trial period so the user isn't billed
    // until their free window runs out. Grants are ordered desc by endsAt, so
    // index 0 is always the furthest-out expiry — no reduce needed.
    const now = new Date();
    const activeGrants = await this.entitlement.getActiveGrants(user.id);
    const latestGrantEnd = activeGrants[0]?.endsAt ?? null;
    const remainingMs = latestGrantEnd ? latestGrantEnd.getTime() - now.getTime() : 0;
    const trialDays = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;

    const successUrl = `${cfg.frontendBaseUrl}/settings/billing?checkout=success`;
    const cancelUrl = `${cfg.frontendBaseUrl}/settings/billing?checkout=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: user.id,
      metadata: { userId: user.id, tier: params.tier },
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      ...(trialDays > 0
        ? {
            subscription_data: {
              trial_period_days: trialDays,
              metadata: {
                userId: user.id,
                tier: params.tier,
                grantTrialDays: String(trialDays),
              },
            },
          }
        : {}),
    });

    const url = (session as any)?.url as string | null | undefined;
    if (!url) throw new BadRequestException('Stripe did not return a checkout URL.');
    return { url };
  }

  async createPortalSession(params: { userId: string }): Promise<BillingPortalSessionDto> {
    const { stripe, cfg } = this.getStripe();
    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { stripeCustomerId: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    if (!isVerified(user.verifiedStatus)) throw new ForbiddenException('Verify your account to manage a subscription.');
    if (!user.stripeCustomerId) throw new BadRequestException('No Stripe customer found for this account.');

    const returnUrl = `${cfg.frontendBaseUrl}/settings/billing`;
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });
    if (!session.url) throw new BadRequestException('Stripe did not return a portal URL.');
    return { url: session.url };
  }

  async handleWebhook(params: { rawBody: Buffer; stripeSignature: string }): Promise<void> {
    const { stripe, cfg } = this.getStripe();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(params.rawBody, params.stripeSignature, cfg.webhookSecret);
    } catch (err: unknown) {
      this.logger.warn(`Stripe webhook signature verification failed: ${(err as Error)?.message ?? String(err)}`);
      throw new BadRequestException('Invalid Stripe signature.');
    }

    // Deduplicate (Stripe may retry).
    try {
      await this.prisma.stripeWebhookEvent.create({ data: { id: event.id } });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return;
      }
      throw e;
    }

    // Only process the events we care about.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
      if (!customerId || !subscriptionId) return;
      await this.syncSubscriptionToUser({ customerId, subscriptionId });
      return;
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
      if (!customerId) return;
      await this.syncSubscriptionToUser({ customerId, subscriptionId: sub.id, subscription: sub });
      return;
    }

    // Refresh entitlement on every successful payment to keep period dates in sync.
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
      const subscriptionId =
        typeof (invoice as any).subscription === 'string'
          ? (invoice as any).subscription
          : (invoice as any).subscription?.id ?? null;
      if (!customerId || !subscriptionId) return;
      await this.syncSubscriptionToUser({ customerId, subscriptionId });
      return;
    }
  }

  private async syncSubscriptionToUser(params: { customerId: string; subscriptionId: string; subscription?: Stripe.Subscription }) {
    const { stripe } = this.getStripe();

    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: params.customerId },
      select: {
        id: true,
        username: true,
        name: true,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
        recruitedById: true,
        referralBonusGrantedAt: true,
      },
    });
    if (!user) return;

    const sub =
      params.subscription ??
      (await stripe.subscriptions.retrieve(params.subscriptionId, {
        expand: ['items.data.price'],
      }));

    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const status = String(sub.status ?? '');
    const cancelAtPeriodEnd = Boolean((sub as any).cancel_at_period_end);
    const currentPeriodEndSec = (sub as any)?.current_period_end as number | null | undefined;
    const currentPeriodEnd = currentPeriodEndSec ? new Date(currentPeriodEndSec * 1000) : null;
    const currentPeriodStartSec = (sub as any)?.current_period_start as number | null | undefined;
    const currentPeriodStart = currentPeriodStartSec ? new Date(currentPeriodStartSec * 1000) : null;

    // Save Stripe state to DB first, then let EntitlementService resolve the effective tier
    // (which may be elevated by active grants).
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: sub.id,
        stripeSubscriptionStatus: status || null,
        stripeSubscriptionPriceId: priceId,
        stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
        stripeCurrentPeriodStart: currentPeriodStart,
        stripeCurrentPeriodEnd: currentPeriodEnd,
      },
    });

    const result = await this.entitlement.recomputeAndApply(user.id);
    const { isPremium, isPremiumPlus } = result;

    await this.publicProfileCache.invalidateForUser({ id: user.id, username: user.username ?? null });

    if (!user.premium && isPremium) {
      this.slack.notifyPremiumGranted({
        userId: user.id,
        username: user.username ?? null,
        name: user.name ?? null,
        tier: isPremiumPlus ? 'premiumPlus' : 'premium',
        source: 'stripe',
      });
    }

    // When the subscription first becomes active (paid), check if a referral bonus should be
    // awarded to this user and their recruiter. The bonus only fires once (guarded by
    // referralBonusGrantedAt) and only when both parties have an active Stripe subscription.
    if (
      status === 'active' &&
      user.recruitedById &&
      !user.referralBonusGrantedAt
    ) {
      try {
        await this.referral.maybeGrantReferralBonus(user.id);
        // Emit realtime update for recruiter too (their grant balance just changed).
        void this.usersMeRealtime.emitMeUpdated(user.recruitedById, 'billing_tier_changed');
      } catch (err) {
        this.logger.warn(`[billing] Failed to grant referral bonus for user ${user.id}: ${err}`);
      }
    }

    this.posthog.capture(user.id, 'tier_changed', {
      stripe_status: status,
      price_id: priceId,
      is_premium: isPremium,
      is_premium_plus: isPremiumPlus,
      cancel_at_period_end: cancelAtPeriodEnd,
    });

    // Realtime: update both public tier badge + self auth state.
    void this.usersPublicRealtime.emitPublicProfileUpdated(user.id);
    void this.usersMeRealtime.emitMeUpdated(user.id, 'billing_tier_changed');
  }
}
