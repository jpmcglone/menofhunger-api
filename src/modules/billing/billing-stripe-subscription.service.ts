import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import type Stripe from "stripe";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PublicProfileCacheService } from "../users/public-profile-cache.service";
import { UsersMeRealtimeService } from "../users/users-me-realtime.service";
import { UsersPublicRealtimeService } from "../users/users-public-realtime.service";
import { PosthogService } from "../../common/posthog/posthog.service";
import { SlackService } from "../../common/slack/slack.service";
import { SideEffectsService } from "../side-effects/side-effects.service";
import { isUniqueViolation } from "../../common/prisma/errors";
import { USER_BRIEF_SELECT } from "../../common/prisma-selects/user.select";
import { EntitlementService } from "./entitlement.service";
import { ReferralService } from "./referral.service";

type StripeCtx = {
  stripe: Stripe;
  cfg: NonNullable<ReturnType<AppConfigService["stripe"]>>;
};

/** Owns verified provider events and the persisted Stripe subscription state. */
@Injectable()
export class BillingStripeSubscriptionService {
  private readonly logger = new Logger(BillingStripeSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly publicProfileCache: PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
    private readonly usersMeRealtime: UsersMeRealtimeService,
    private readonly usersPublicRealtime: UsersPublicRealtimeService,
    private readonly posthog: PosthogService,
    private readonly slack: SlackService,
    private readonly entitlement: EntitlementService,
    private readonly referral: ReferralService,
    private readonly sideEffects: SideEffectsService,
  ) {}

  client(): StripeCtx {
    const cfg = this.appConfig.stripe();
    if (!cfg)
      throw new ServiceUnavailableException("Billing is not configured.");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const StripeCtor: typeof Stripe = require("stripe");
    const stripe = new StripeCtor(cfg.secretKey, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
      typescript: true,
    });
    return { stripe, cfg };
  }

  async handleWebhook(params: {
    rawBody: Buffer;
    stripeSignature: string;
  }): Promise<void> {
    const { stripe, cfg } = this.client();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        params.rawBody,
        params.stripeSignature,
        cfg.webhookSecret,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Stripe webhook signature verification failed: ${(err as Error)?.message ?? String(err)}`,
      );
      throw new BadRequestException("Invalid Stripe signature.");
    }

    // Two-phase dedup: only skip when processedAt is set (handler completed successfully).
    // A row with processedAt=null means a previous attempt claimed the event but crashed
    // before finishing — that retry is safe to re-run because syncSubscriptionToUser is idempotent.
    const existing = await this.prisma.stripeWebhookEvent.findUnique({
      where: { id: event.id },
      select: { processedAt: true },
    });
    if (existing?.processedAt) return; // fully handled on a prior attempt — skip
    if (!existing) {
      try {
        await this.prisma.stripeWebhookEvent.create({ data: { id: event.id } });
      } catch (e: unknown) {
        if (!isUniqueViolation(e)) throw e;
        // Concurrent request raced us to the insert — re-check processedAt before proceeding.
        const concurrent = await this.prisma.stripeWebhookEvent.findUnique({
          where: { id: event.id },
          select: { processedAt: true },
        });
        if (concurrent?.processedAt) return;
      }
    }

    // Only process the events we care about.
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null);
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      if (!customerId || !subscriptionId) {
        await this.prisma.stripeWebhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return;
      }
      await this.syncSubscriptionToUser({ customerId, subscriptionId });
      await this.prisma.stripeWebhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return;
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string"
          ? sub.customer
          : (sub.customer?.id ?? null);
      if (!customerId) {
        await this.prisma.stripeWebhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return;
      }
      await this.syncSubscriptionToUser({
        customerId,
        subscriptionId: sub.id,
        subscription: sub,
      });
      await this.prisma.stripeWebhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return;
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : (invoice.customer?.id ?? null);
      const owner = customerId
        ? await this.prisma.user.findFirst({
            where: { stripeCustomerId: customerId },
            select: { id: true, stripeSubscriptionId: true },
          })
        : null;
      if (
        owner?.stripeSubscriptionId &&
        invoice.id &&
        this.invoiceSubscriptionId(invoice) === owner.stripeSubscriptionId
      ) {
        // Provider state, not a browser checkout redirect, proves a billing problem.
        await this.syncSubscriptionToUser({
          customerId: customerId!,
          subscriptionId: owner.stripeSubscriptionId,
        });
        this.sideEffects.dispatch("email.lifecycle", {
          kind: "paymentAttention",
          userId: owner.id,
          source: "stripe",
          eventId: invoice.id,
          occurredAt: new Date(event.created * 1000).toISOString(),
        });
      }
      await this.prisma.stripeWebhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return;
    }

    // Refresh entitlement on every successful payment to keep period dates in sync.
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : (invoice.customer?.id ?? null);
      const subscriptionId = this.invoiceSubscriptionId(invoice);
      if (!customerId || !subscriptionId) {
        await this.prisma.stripeWebhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return;
      }
      await this.syncSubscriptionToUser({ customerId, subscriptionId });
      await this.prisma.stripeWebhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      return;
    }

    // Unrecognised event type — mark processed so we don't log it repeatedly on retry.
    await this.prisma.stripeWebhookEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
  }

  private invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    // Current API payloads nest subscription identity under parent; accept older signed events too.
    const subscription =
      invoice.parent?.subscription_details?.subscription ??
      (
        invoice as Stripe.Invoice & {
          subscription?: string | { id: string } | null;
        }
      ).subscription;
    return typeof subscription === "string"
      ? subscription
      : (subscription?.id ?? null);
  }

  async syncSubscriptionToUser(params: {
    customerId: string;
    subscriptionId: string;
    subscription?: Stripe.Subscription;
  }) {
    const { stripe } = this.client();

    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: params.customerId },
      select: {
        ...USER_BRIEF_SELECT,
        verifiedStatus: true,
        premium: true,
        premiumPlus: true,
        recruitedById: true,
        referralBonusGrantedAt: true,
        stripeCancelAtPeriodEnd: true,
      },
    });
    if (!user) return;

    const sub =
      params.subscription ??
      (await stripe.subscriptions.retrieve(params.subscriptionId, {
        expand: ["items.data.price"],
      }));

    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const status = String(sub.status ?? "");
    const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
    // Period bounds moved off `Subscription` in newer typings but are still present on the payload.
    const periodBounds = sub as Stripe.Subscription & {
      current_period_start?: number | null;
      current_period_end?: number | null;
    };
    const currentPeriodEndSec = periodBounds.current_period_end;
    const currentPeriodEnd = currentPeriodEndSec
      ? new Date(currentPeriodEndSec * 1000)
      : null;
    const currentPeriodStartSec = periodBounds.current_period_start;
    const currentPeriodStart = currentPeriodStartSec
      ? new Date(currentPeriodStartSec * 1000)
      : null;

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

    if (
      cancelAtPeriodEnd &&
      !user.stripeCancelAtPeriodEnd &&
      currentPeriodEnd
    ) {
      this.sideEffects.dispatch("email.lifecycle", {
        kind: "cancellation",
        userId: user.id,
        source: "stripe",
        eventId: `${sub.id}-${currentPeriodEnd.toISOString()}`,
        occurredAt: new Date().toISOString(),
      });
    }

    const result = await this.entitlement.recomputeAndApply(user.id);
    const { isPremium, isPremiumPlus } = result;

    await this.publicProfileCache.invalidateForUser({
      id: user.id,
      username: user.username ?? null,
    });

    if (!user.premium && isPremium) {
      this.slack.notifyPremiumGranted({
        userId: user.id,
        username: user.username ?? null,
        name: user.name ?? null,
        tier: isPremiumPlus ? "premiumPlus" : "premium",
        source: "stripe",
      });
    }

    // The referral month is granted on verification. A paid subscription only records the
    // affiliate premium milestone (idempotent).
    if (status === "active" && user.recruitedById) {
      await this.referral.recordPremiumMilestone(user.id);
    }

    this.posthog.capture(user.id, "tier_changed", {
      stripe_status: status,
      price_id: priceId,
      is_premium: isPremium,
      is_premium_plus: isPremiumPlus,
      cancel_at_period_end: cancelAtPeriodEnd,
    });

    // Realtime: update both public tier badge + self auth state.
    void this.usersPublicRealtime.emitPublicProfileUpdated(user.id);
    void this.usersMeRealtime.emitMeUpdated(user.id, "billing_tier_changed");
  }
}
