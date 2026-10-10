import { Injectable, OnModuleInit } from "@nestjs/common";
import { PostsReadService } from "../posts-read/posts-read.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { EmailService, buildLifecycleEmail, buildGreeting } from "../email";
import { isPayingSubscriber, lifecycleTierEventId } from "../billing";
import { SideEffectsRegistry } from "../side-effects/side-effects.registry";
import { SideEffectsService } from "../side-effects/side-effects.service";
import type { LifecycleEmailEvent } from "./email-lifecycle.types";

const DAY = 86400000;
export const APPLE_BILLING_URL = "https://apps.apple.com/account/subscriptions";

@Injectable()
export class EmailLifecycleService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly email: EmailService,
    private readonly registry: SideEffectsRegistry,
    private readonly effects: SideEffectsService,
    private readonly postsRead: PostsReadService,
  ) {}

  onModuleInit(): void {
    this.registry.register("email.lifecycle", (event) => this.send(event));
  }

  async send(event: LifecycleEmailEvent): Promise<void> {
    const now = new Date();
    const at = new Date(event.occurredAt);
    const maximumAge = event.kind === "premiumTip" ? 4 * DAY : DAY;
    if (
      !Number.isFinite(at.getTime()) ||
      at > now ||
      now.getTime() - at.getTime() > maximumAge
    )
      return;
    const user = await this.prisma.user.findUnique({
      where: { id: event.userId },
      select: {
        id: true,
        accountKind: true,
        isBot: true,
        bannedAt: true,
        email: true,
        emailVerifiedAt: true,
        name: true,
        username: true,
        verifiedStatus: true,
        verifiedAt: true,
        premium: true,
        premiumPlus: true,
        stripeSubscriptionId: true,
        stripeCurrentPeriodStart: true,
        appleOriginalTransactionId: true,
        stripeSubscriptionStatus: true,
        stripeSubscriptionPriceId: true,
        stripeCancelAtPeriodEnd: true,
        stripeCurrentPeriodEnd: true,
        appleStatus: true,
        appleProductId: true,
        appleExpiresAt: true,
        appleAutoRenew: true,
        recruitedById: true,
        referralBonusGrantedAt: true,
        subscriptionGrants: {
          where: { revokedAt: null, endsAt: { gt: now } },
          orderBy: { endsAt: "desc" },
        },
      },
    });
    if (!user || user.accountKind !== "person" || user.isBot || user.bannedAt)
      return;
    const to =
      event.kind === "accountChanged"
        ? event.previousVerifiedEmail
        : user.emailVerifiedAt
          ? user.email
          : null;
    if (!to) return;
    const base = (
      this.config.frontendBaseUrl() ?? "https://menofhunger.com"
    ).replace(/\/$/, "");
    const billingUrl =
      event.source === "apple" ? APPLE_BILLING_URL : `${base}/settings/billing`;
    const paidStripe = isPayingSubscriber(
      { ...user, appleStatus: null, appleExpiresAt: null },
      now,
    );
    const paidApple =
      ["active", "grace"].includes(user.appleStatus ?? "") &&
      Boolean(user.appleExpiresAt && user.appleExpiresAt > now);
    const eligibleGrants = user.subscriptionGrants.filter(
      (g) => !g.requiresActiveSubscription || paidStripe,
    );
    const standaloneGrants = eligibleGrants.filter((g) => g.startsAt <= now);
    // Effective user flags also include TestFlight/Sandbox access; lifecycle mail uses real sources.
    let tier: "premium" | "premiumPlus" =
      (paidStripe &&
        user.stripeSubscriptionPriceId ===
          this.config.stripe()?.pricePremiumPlusMonthly) ||
      (paidApple &&
        this.config.appleIap()?.productTierMap[user.appleProductId ?? ""] ===
          "premiumPlus") ||
      standaloneGrants.some((g) => g.tier === "premiumPlus")
        ? "premiumPlus"
        : "premium";
    const currentGrant = standaloneGrants.find((g) =>
      event.grantId
        ? g.id === event.grantId
        : event.kind === "premium"
          ? g.id === event.eventId
          : (tier !== "premiumPlus" || g.tier === "premiumPlus") &&
            (event.source !== "referral" || g.source === "referral"),
    );
    const expiry =
      event.source === "apple"
        ? user.appleExpiresAt
        : event.source === "stripe"
          ? user.stripeCurrentPeriodEnd
          : (currentGrant?.endsAt ?? null);
    const accessTerms =
      paidStripe || paidApple ? ("managed" as const) : ("ends" as const);
    let kind = event.kind;
    let url = `${base}/home`;
    let verified = false;
    let rewardName: string | null = null;
    let expiresAt = expiry?.toISOString() ?? null;
    let source = event.source;
    if (event.kind === "paymentAttention" || event.kind === "cancellation")
      tier =
        event.source === "apple"
          ? this.config.appleIap()?.productTierMap[
              user.appleProductId ?? ""
            ] === "premiumPlus"
            ? "premiumPlus"
            : "premium"
          : user.stripeSubscriptionPriceId ===
              this.config.stripe()?.pricePremiumPlusMonthly
            ? "premiumPlus"
            : "premium";
    let tip: "schedule" | "group" | "marv" | undefined;

    if (kind === "verified") {
      if (
        user.verifiedStatus === "none" ||
        !user.verifiedAt ||
        user.verifiedAt.toISOString() !== event.eventId
      )
        return;
      verified = true;
      if (
        user.premium &&
        (paidStripe || paidApple || standaloneGrants.length > 0)
      ) {
        kind = "premium";
        const stripeSupportsTier =
          paidStripe &&
          (tier !== "premiumPlus" ||
            user.stripeSubscriptionPriceId ===
              this.config.stripe()?.pricePremiumPlusMonthly);
        const appleSupportsTier =
          paidApple &&
          (tier !== "premiumPlus" ||
            this.config.appleIap()?.productTierMap[
              user.appleProductId ?? ""
            ] === "premiumPlus");
        source = stripeSupportsTier
          ? "stripe"
          : appleSupportsTier
            ? "apple"
            : currentGrant?.source === "referral"
              ? "referral"
              : "grant";
        expiresAt =
          source === "stripe"
            ? (user.stripeCurrentPeriodEnd?.toISOString() ?? null)
            : source === "apple"
              ? (user.appleExpiresAt?.toISOString() ?? null)
              : (currentGrant?.endsAt.toISOString() ?? null);
        url = `${base}/settings/billing`;
      }
      if (
        user.referralBonusGrantedAt &&
        user.referralBonusGrantedAt.getTime() >= user.verifiedAt.getTime()
      )
        rewardName = "a man who invited you";
    } else if (kind === "premium") {
      if (event.source === "referral") return;
      if (!user.premium || (event.tier && event.tier !== tier)) return;
      if (
        (event.source === "stripe" && !paidStripe) ||
        (event.source === "apple" && !paidApple)
      )
        return;
      if (
        !event.source ||
        event.eventId !==
          lifecycleTierEventId({
            ...user,
            source: event.source,
            tier,
            grantId: standaloneGrants.find((g) => g.id === event.eventId)?.id,
          })
      )
        return;
      url = `${base}/settings/billing`;
    } else if (kind === "referralReward") {
      if (user.id === event.recruitId && event.combinedVerification) return;
      const recruit = event.recruitId
        ? await this.prisma.user.findUnique({
            where: { id: event.recruitId },
            select: {
              name: true,
              username: true,
              referralBonusGrantedAt: true,
              recruitedById: true,
            },
          })
        : null;
      if (
        !recruit?.referralBonusGrantedAt ||
        (user.id !== event.recruitId && recruit.recruitedById !== user.id)
      )
        return;
      rewardName =
        user.id === event.recruitId
          ? null
          : recruit.name?.trim() || recruit.username || "the man you invited";
      if (!user.premium) return;
      source = "referral";
      url = `${base}/settings/billing`;
    } else if (kind === "grantExpiring") {
      const grant = standaloneGrants.find((g) => g.id === event.grantId);
      if (!grant || !user.premium) return;
      const stripeCoversTier =
        paidStripe &&
        (grant.tier === "premium" ||
          user.stripeSubscriptionPriceId ===
            this.config.stripe()?.pricePremiumPlusMonthly);
      const appleCoversTier =
        paidApple &&
        (grant.tier === "premium" ||
          this.config.appleIap()?.productTierMap[user.appleProductId ?? ""] ===
            "premiumPlus");
      if (
        stripeCoversTier ||
        appleCoversTier ||
        eligibleGrants.some(
          (g) =>
            g.startsAt <= grant.endsAt &&
            g.endsAt > grant.endsAt &&
            (grant.tier === "premium" || g.tier === "premiumPlus"),
        )
      )
        return;
      tier = grant.tier;
      // A changed/extended grant invalidates the original event identity.
      if (
        event.eventId !==
          `grant-expiring-${grant.id}-${grant.endsAt.toISOString()}` ||
        grant.endsAt.getTime() - now.getTime() > 3 * DAY
      )
        return;
      expiresAt = grant.endsAt.toISOString();
      source = grant.source === "referral" ? "referral" : "grant";
      url = billingUrl;
    } else if (kind === "cancellation") {
      if (!expiry || expiry <= now) return;
      if (
        event.source === "stripe"
          ? user.stripeCancelAtPeriodEnd !== true ||
            event.eventId !==
              `${user.stripeSubscriptionId}-${user.stripeCurrentPeriodEnd?.toISOString()}`
          : user.appleAutoRenew !== false ||
            event.eventId !==
              `${user.appleOriginalTransactionId}-${user.appleExpiresAt?.getTime()}`
      )
        return;
      url = billingUrl;
    } else if (kind === "paymentAttention") {
      if (!this.config.emailBillingNoticesEnabled()) return;
      if (
        event.source === "stripe"
          ? !["past_due", "unpaid"].includes(
              user.stripeSubscriptionStatus ?? "",
            )
          : !["grace", "billing_retry"].includes(user.appleStatus ?? "")
      )
        return;
      url = billingUrl;
    } else if (kind === "verificationAction") {
      const request = await this.prisma.verificationRequest.findUnique({
        where: { id: event.requestId ?? "" },
        select: { status: true, userId: true },
      });
      if (
        !request ||
        request.userId !== user.id ||
        request.status !== "rejected" ||
        user.verifiedStatus !== "none"
      )
        return;
      url = `${base}/settings/verification`;
    } else if (kind === "accountChanged") {
      url = `${base}/settings/account`;
    } else if (kind === "premiumTip") {
      if (
        !user.premium ||
        user.verifiedStatus === "none" ||
        now.getTime() - at.getTime() < 3 * DAY
      )
        return;
      const [scheduled, group, marv] = await Promise.all([
        this.postsRead.count({
          where: {
            userId: user.id,
            OR: [
              { scheduledAt: { not: null } },
              { scheduledPublishedPostId: { not: null } },
            ],
            createdAt: { gte: at },
          },
        }),
        this.prisma.communityGroup.count({
          where: { createdByUserId: user.id, createdAt: { gte: at } },
        }),
        this.prisma.marvinUsageEvent.count({
          where: { userId: user.id, errorCode: null, createdAt: { gte: at } },
        }),
      ]);
      if (scheduled || group || marv) return;
      tip = "schedule";
      url = `${base}/home`;
    }
    const content = buildLifecycleEmail({
      kind,
      greeting: buildGreeting(user),
      url,
      settingsUrl: `${base}/settings/notifications`,
      billingUrl:
        source === "apple" ? APPLE_BILLING_URL : `${base}/settings/billing`,
      tier,
      source,
      expiresAt,
      verified,
      rewardName,
      changedField: event.changedField,
      occurredAt: event.occurredAt,
      accessTerms,
      tip,
    });
    const result = await this.email.sendText({
      to,
      ...content,
      replyTo: "hello@menofhunger.com",
      category: ["premiumTip", "grantExpiring"].includes(event.kind)
        ? "engagement"
        : "transactional",
      preference: ["premiumTip", "grantExpiring"].includes(event.kind)
        ? "emailOnboarding"
        : undefined,
      userId: user.id,
      eventKey: `lifecycle:${event.kind}:${user.id}:${event.kind === "verified" ? "first" : event.eventId}`,
      recipientMode: event.kind === "accountChanged" ? "previous" : "current",
      retrySafe: false,
    });
    if (!result.sent && result.retryable)
      throw new Error(
        `Lifecycle email will retry: ${result.reason ?? "transient_failure"}`,
      );
    if (result.sent && kind === "premium")
      this.effects.dispatch(
        "email.lifecycle",
        { ...event, kind: "premiumTip" },
        {
          delay: 3 * DAY,
          jobId: `premium-tip-${user.id}-${event.eventId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        },
      );
  }
}
