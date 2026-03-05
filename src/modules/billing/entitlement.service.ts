import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Grant N months of premium to a user.
   * Grants stack: if the user already has an active grant, the new grant starts
   * from the latest endsAt so the time accumulates cleanly.
   *
   * This is the single callable entry point for all grant sources (admin, future referral, etc.).
   */
  async grantMonths(params: {
    userId: string;
    tier: GrantTier;
    months: number;
    source: 'admin' | 'referral';
    grantedByAdminId?: string | null;
    reason?: string | null;
  }): Promise<{ grant: SubscriptionGrant; entitlement: EntitlementResult }> {
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, verifiedStatus: true },
    });
    if (!user) throw new NotFoundException('User not found.');

    // Stack: new grant starts from the latest active grant end, or now.
    const latest = await this.prisma.subscriptionGrant.findFirst({
      where: { userId: params.userId, revokedAt: null, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });

    const startsAt = latest ? latest.endsAt : now;
    const endsAt = addMonths(startsAt, params.months);

    const grant = await this.prisma.subscriptionGrant.create({
      data: {
        userId: params.userId,
        tier: params.tier,
        source: params.source,
        months: params.months,
        startsAt,
        endsAt,
        reason: params.reason ?? null,
        grantedByAdminId: params.grantedByAdminId ?? null,
      },
    });

    const entitlement = await this.recomputeAndApply(params.userId);
    return { grant, entitlement };
  }

  /**
   * Set the total free months for a tier to an exact value.
   * All currently active grants for that tier are revoked and replaced with a single
   * consolidated grant from now to `now + months`. Pass 0 to clear entirely.
   *
   * Use this for admin edits. For automated stacking (e.g. referral rewards), use `grantMonths`.
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
   * Returns the total remaining months of free premium and premium+ the user has banked.
   * Calculated from the wall-clock time remaining across all active grants per tier.
   */
  async getGrantSummary(userId: string): Promise<{ premiumMonthsRemaining: number; premiumPlusMonthsRemaining: number }> {
    const now = new Date();
    const grants = await this.prisma.subscriptionGrant.findMany({
      where: { userId, revokedAt: null, endsAt: { gt: now } },
    });

    const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;
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

  /** Revoke an active grant early. Re-resolves the user's effective tier. */
  async revokeGrant(params: { grantId: string; userId: string }): Promise<EntitlementResult> {
    const grant = await this.prisma.subscriptionGrant.findFirst({
      where: { id: params.grantId, userId: params.userId },
    });
    if (!grant) throw new NotFoundException('Grant not found.');
    if (grant.revokedAt) throw new BadRequestException('Grant is already revoked.');

    await this.prisma.subscriptionGrant.update({
      where: { id: params.grantId },
      data: { revokedAt: new Date() },
    });

    return this.recomputeAndApply(params.userId);
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

  /** Get all grants for a user (including revoked/expired), sorted newest first. */
  async getAllGrants(userId: string): Promise<ActiveGrantInfo[]> {
    const rows = await this.prisma.subscriptionGrant.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
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

    // Grants work standalone — no active Stripe subscription required.
    // Priority: Premium+ grant > Premium grant > Stripe > none.
    const grantTier: EffectiveTier =
      activeGrants.length === 0
        ? 'none'
        : activeGrants.some((g) => g.tier === 'premiumPlus')
          ? 'premiumPlus'
          : 'premium';
    const grantExpiresAt = activeGrants.length > 0 ? activeGrants[0]!.endsAt : null;

    const effectiveTier = maxTier(grantTier, stripeTier);
    const isPremiumPlus = effectiveTier === 'premiumPlus';
    const isPremium = effectiveTier !== 'none';

    // effectiveExpiresAt: for the current effective tier, what is the furthest access window.
    // Take the maximum of stripe expiry and grant expiry.
    let effectiveExpiresAt: Date | null = null;
    if (stripeExpiresAt && grantExpiresAt) {
      effectiveExpiresAt = stripeExpiresAt > grantExpiresAt ? stripeExpiresAt : grantExpiresAt;
    } else {
      effectiveExpiresAt = stripeExpiresAt ?? grantExpiresAt;
    }

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
