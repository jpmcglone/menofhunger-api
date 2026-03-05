import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SubscriptionGrant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../app/app-config.service';

export type GrantTier = 'premium' | 'premiumPlus';
export type EffectiveTier = 'none' | 'premium' | 'premiumPlus';

export type ActiveGrantInfo = {
  id: string;
  tier: GrantTier;
  source: 'admin' | 'referral';
  months: number;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  grantedByAdminId: string | null;
  createdAt: Date;
};

export type EntitlementResult = {
  isPremium: boolean;
  isPremiumPlus: boolean;
  effectiveTier: EffectiveTier;
  effectiveExpiresAt: Date | null;
  stripeExpiresAt: Date | null;
  grantExpiresAt: Date | null;
  activeGrants: ActiveGrantInfo[];
};

function tierRank(tier: EffectiveTier): number {
  return tier === 'premiumPlus' ? 2 : tier === 'premium' ? 1 : 0;
}

function maxTier(a: EffectiveTier, b: EffectiveTier): EffectiveTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** Stack months starting from the latest active grant end (or now if no active grants). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

const ENTITLED_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due']);

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

/** Returns the later of two nullable dates, or null if both are null. */
export function laterDate(a: Date | null, b: Date | null): Date | null {
  return a && b ? (a > b ? a : b) : a ?? b;
}

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Set the total free months for a tier to an exact value.
   * All currently active grants for that tier are revoked and replaced with a single
   * consolidated grant from now to `now + months`. Pass 0 to clear entirely.
   */
  async setGrantMonths(params: {
    userId: string;
    tier: GrantTier;
    months: number;
    grantedByAdminId?: string | null;
    reason?: string | null;
  }): Promise<EntitlementResult> {
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    // Revoke all currently active grants for this tier.
    await this.prisma.subscriptionGrant.updateMany({
      where: { userId: params.userId, tier: params.tier, revokedAt: null, endsAt: { gt: now } },
      data: { revokedAt: now },
    });

    if (params.months > 0) {
      const endsAt = addMonths(now, params.months);
      await this.prisma.subscriptionGrant.create({
        data: {
          userId: params.userId,
          tier: params.tier,
          source: 'admin',
          months: params.months,
          startsAt: now,
          endsAt,
          reason: params.reason ?? null,
          grantedByAdminId: params.grantedByAdminId ?? null,
        },
      });
    }

    return this.recomputeAndApply(params.userId);
  }

  /**
   * Called when a user is re-verified after a period of being unverified.
   * Extends the endsAt of any grants that were still active when they lost verification
   * by the length of the unverified window, so they get credit for time they couldn't use.
   *
   * Safe to call with a null unverifiedAt (no-op) — e.g. for first-time verifications.
   */
  async extendGrantsAfterPause(userId: string, unverifiedAt: Date | null): Promise<void> {
    if (!unverifiedAt) return;
    const now = new Date();
    const pauseMs = now.getTime() - unverifiedAt.getTime();
    if (pauseMs <= 0) return;

    // Find all non-revoked grants that were still running when they lost verification.
    const grants = await this.prisma.subscriptionGrant.findMany({
      where: { userId, revokedAt: null, endsAt: { gt: unverifiedAt } },
    });

    for (const g of grants) {
      await this.prisma.subscriptionGrant.update({
        where: { id: g.id },
        data: { endsAt: new Date(g.endsAt.getTime() + pauseMs) },
      });
    }

    if (grants.length > 0) {
      const days = Math.round(pauseMs / (1000 * 60 * 60 * 24));
      this.logger.log(`[entitlement] Extended ${grants.length} grant(s) for user ${userId} by ${days}d (unverified period)`);
    }
  }

  /**
   * Returns the total remaining months of free premium and premium+ the user has banked.
   * Calculated from the wall-clock time remaining across all active grants per tier.
   */
  async getGrantSummary(userId: string): Promise<{ premiumMonthsRemaining: number; premiumPlusMonthsRemaining: number }> {
    const now = new Date();
    const grants = await this.prisma.subscriptionGrant.findMany({
      where: { userId, revokedAt: null, endsAt: { gt: now } },
    });

    let premiumMs = 0;
    let premiumPlusMs = 0;
    for (const g of grants) {
      const remaining = Math.max(0, g.endsAt.getTime() - now.getTime());
      if (g.tier === 'premiumPlus') premiumPlusMs += remaining;
      else premiumMs += remaining;
    }

    return {
      premiumMonthsRemaining: Math.round(premiumMs / MS_PER_MONTH),
      premiumPlusMonthsRemaining: Math.round(premiumPlusMs / MS_PER_MONTH),
    };
  }

  /** Get all active (non-revoked, non-expired) grants for a user, sorted with latest end first. */
  async getActiveGrants(userId: string): Promise<ActiveGrantInfo[]> {
    const now = new Date();
    const rows = await this.prisma.subscriptionGrant.findMany({
      where: { userId, revokedAt: null, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });
    return rows.map(this.toGrantInfo);
  }

  /**
   * Recompute effective entitlement from Stripe state + active grants, then persist
   * the resolved premium/premiumPlus booleans to User. Returns the result.
   *
   * Called after: webhook syncs, grant creation/revocation.
   */
  async recomputeAndApply(userId: string): Promise<EntitlementResult> {
    const now = new Date();
    const cfg = this.appConfig.stripe();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        verifiedStatus: true,
        stripeSubscriptionStatus: true,
        stripeSubscriptionPriceId: true,
        stripeCurrentPeriodEnd: true,
        subscriptionGrants: {
          where: { revokedAt: null, endsAt: { gt: now } },
          orderBy: { endsAt: 'desc' },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found.');

    const verified = user.verifiedStatus !== 'none';
    const stripeStatus = user.stripeSubscriptionStatus ?? '';
    const stripeEntitled = verified && ENTITLED_STRIPE_STATUSES.has(stripeStatus);

    const stripeIsPlus =
      stripeEntitled && Boolean(cfg) && user.stripeSubscriptionPriceId === cfg!.pricePremiumPlusMonthly;
    const stripeIsPremium =
      stripeEntitled &&
      Boolean(cfg) &&
      (user.stripeSubscriptionPriceId === cfg!.pricePremiumMonthly || stripeIsPlus);

    const stripeTier: EffectiveTier = stripeIsPlus ? 'premiumPlus' : stripeIsPremium ? 'premium' : 'none';
    const stripeExpiresAt = stripeEntitled ? (user.stripeCurrentPeriodEnd ?? null) : null;

    const activeGrants = user.subscriptionGrants.map(this.toGrantInfo);

    // Grants require verification — unverified users bank months but cannot use them.
    // Priority when verified: Premium+ grant > Premium grant > Stripe > none.
    const grantTier: EffectiveTier =
      !verified || activeGrants.length === 0
        ? 'none'
        : activeGrants.some((g) => g.tier === 'premiumPlus')
          ? 'premiumPlus'
          : 'premium';
    const grantExpiresAt = verified && activeGrants.length > 0 ? activeGrants[0]!.endsAt : null;

    const effectiveTier = maxTier(grantTier, stripeTier);
    const isPremiumPlus = effectiveTier === 'premiumPlus';
    const isPremium = effectiveTier !== 'none';

    // effectiveExpiresAt: latest access window across Stripe + grant.
    const effectiveExpiresAt = laterDate(stripeExpiresAt, grantExpiresAt);

    await this.prisma.user.update({
      where: { id: userId },
      data: { premium: isPremium, premiumPlus: isPremiumPlus },
    });

    return {
      isPremium,
      isPremiumPlus,
      effectiveTier,
      effectiveExpiresAt,
      stripeExpiresAt,
      grantExpiresAt,
      activeGrants,
    };
  }

  private toGrantInfo = (g: SubscriptionGrant): ActiveGrantInfo => ({
    id: g.id,
    tier: g.tier as GrantTier,
    source: g.source as 'admin' | 'referral',
    months: g.months,
    startsAt: g.startsAt,
    endsAt: g.endsAt,
    reason: g.reason,
    grantedByAdminId: g.grantedByAdminId,
    createdAt: g.createdAt,
  });
}
