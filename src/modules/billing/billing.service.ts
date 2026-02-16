import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';
import type { BillingCheckoutSessionDto, BillingMeDto, BillingPortalSessionDto, BillingTier } from '../../common/dto';
import type { VerifiedStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';

type StripeCtx = { stripe: Stripe; cfg: NonNullable<ReturnType<AppConfigService['stripe']>> };

function isVerified(status: VerifiedStatus | string | null | undefined): boolean {
  return Boolean(status && status !== 'none');
}

function entitledStatuses(status: string): boolean {
  // Keep a small grace window for payment retries (past_due). Stripe may flip through states quickly.
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{ id: string; username: string | null }>,
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
      },
    });
    if (!user) throw new NotFoundException('User not found.');
    return {
      premium: Boolean(user.premium),
      premiumPlus: Boolean(user.premiumPlus),
      verified: isVerified(user.verifiedStatus),
      subscriptionStatus: user.stripeSubscriptionStatus ?? null,
      cancelAtPeriodEnd: Boolean(user.stripeCancelAtPeriodEnd),
      currentPeriodEnd: user.stripeCurrentPeriodEnd ? user.stripeCurrentPeriodEnd.toISOString() : null,
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

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
      if (!customerId) return;
      await this.syncSubscriptionToUser({ customerId, subscriptionId: sub.id, subscription: sub });
      return;
    }
  }

  private async syncSubscriptionToUser(params: { customerId: string; subscriptionId: string; subscription?: Stripe.Subscription }) {
    const { stripe, cfg } = this.getStripe();

    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: params.customerId },
      select: { id: true, username: true, verifiedStatus: true },
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

    const verified = isVerified(user.verifiedStatus);
    const entitled = verified && entitledStatuses(status) && Boolean(priceId);
    const isPlus = entitled && priceId === cfg.pricePremiumPlusMonthly;
    const isPremium = entitled && (priceId === cfg.pricePremiumMonthly || isPlus);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: sub.id,
        stripeSubscriptionStatus: status || null,
        stripeSubscriptionPriceId: priceId,
        stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
        stripeCurrentPeriodEnd: currentPeriodEnd,
        premium: isPremium,
        premiumPlus: isPlus,
      },
    });
    await this.publicProfileCache.invalidateForUser({ id: user.id, username: user.username ?? null });
  }
}

