import { NotFoundException } from '@nestjs/common';
import { EntitlementService, laterDate } from './entitlement.service';

type Deps = {
  prisma: any;
  appConfig: any;
};

const STRIPE_CFG = {
  secretKey: 'sk_test',
  webhookSecret: 'whsec',
  frontendBaseUrl: 'https://example.test',
  pricePremiumMonthly: 'price_premium',
  pricePremiumPlusMonthly: 'price_premium_plus',
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    prisma: {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(async () => ({})),
      },
      subscriptionGrant: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async () => ({})),
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
      },
    },
    appConfig: {
      stripe: jest.fn(() => STRIPE_CFG),
      appleIap: jest.fn(() => null),
    },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new EntitlementService(deps.prisma, deps.appConfig);
  return { service, deps };
}

function grantRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'g1',
    tier: 'premium',
    source: 'admin',
    months: 1,
    startsAt: new Date(now - 1000),
    endsAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
    reason: null,
    grantedByAdminId: null,
    createdAt: new Date(now - 1000),
    requiresActiveSubscription: false,
    revokedAt: null,
    userId: 'u1',
    ...overrides,
  };
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    verifiedStatus: 'identity',
    stripeSubscriptionStatus: null,
    stripeSubscriptionPriceId: null,
    stripeCurrentPeriodEnd: null,
    appleProductId: null,
    appleStatus: null,
    appleExpiresAt: null,
    subscriptionGrants: [],
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('laterDate', () => {
  it('returns the later of two dates', () => {
    const a = new Date('2030-01-01');
    const b = new Date('2031-01-01');
    expect(laterDate(a, b)).toBe(b);
    expect(laterDate(b, a)).toBe(b);
  });

  it('handles nulls', () => {
    const a = new Date('2030-01-01');
    expect(laterDate(a, null)).toBe(a);
    expect(laterDate(null, a)).toBe(a);
    expect(laterDate(null, null)).toBeNull();
  });
});

describe('EntitlementService.recomputeAndApply', () => {
  it('throws NotFoundException when the user is missing', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.recomputeAndApply('missing')).rejects.toThrow(NotFoundException);
  });

  it('grants premium from an active Stripe premium subscription', async () => {
    const { service, deps } = makeService();
    const periodEnd = new Date('2030-06-01T00:00:00Z');
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPriceId: 'price_premium',
        stripeCurrentPeriodEnd: periodEnd,
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.isPremium).toBe(true);
    expect(result.isPremiumPlus).toBe(false);
    expect(result.effectiveTier).toBe('premium');
    expect(result.stripeExpiresAt).toEqual(periodEnd);
    expect(result.effectiveExpiresAt).toEqual(periodEnd);
    expect(deps.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { premium: true, premiumPlus: false },
    });
  });

  it('grants premium+ from the premium+ Stripe price', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'trialing',
        stripeSubscriptionPriceId: 'price_premium_plus',
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('premiumPlus');
    expect(deps.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { premium: true, premiumPlus: true },
    });
  });

  it('does not entitle an unverified user even with an active Stripe subscription and grants', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        verifiedStatus: 'none',
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPriceId: 'price_premium',
        subscriptionGrants: [grantRow()],
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('none');
    expect(result.isPremium).toBe(false);
    // Grants are still banked (returned), just not applied.
    expect(result.activeGrants).toHaveLength(1);
    expect(deps.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { premium: false, premiumPlus: false },
    });
  });

  it('grants premium from an admin grant without any Stripe subscription', async () => {
    const { service, deps } = makeService();
    const grant = grantRow();
    deps.prisma.user.findUnique.mockResolvedValue(userRow({ subscriptionGrants: [grant] }));

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('premium');
    expect(result.grantExpiresAt).toEqual(grant.endsAt);
    expect(result.stripeExpiresAt).toBeNull();
  });

  it('ignores referral grants when there is no active Stripe subscription', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        subscriptionGrants: [grantRow({ source: 'referral', requiresActiveSubscription: true })],
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('none');
    expect(result.isPremium).toBe(false);
  });

  it('counts referral grants when the Stripe subscription is active', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPriceId: 'price_premium',
        subscriptionGrants: [
          grantRow({ tier: 'premiumPlus', source: 'referral', requiresActiveSubscription: true }),
        ],
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('premiumPlus');
  });

  it('lets a premium+ grant outrank a premium Stripe subscription', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPriceId: 'price_premium',
        subscriptionGrants: [grantRow({ tier: 'premiumPlus' })],
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveTier).toBe('premiumPlus');
    expect(result.isPremiumPlus).toBe(true);
  });

  it('treats past_due as entitled (grace period)', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'past_due',
        stripeSubscriptionPriceId: 'price_premium',
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.isPremium).toBe(true);
  });

  it('treats canceled as not entitled', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'canceled',
        stripeSubscriptionPriceId: 'price_premium',
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.isPremium).toBe(false);
    expect(result.stripeExpiresAt).toBeNull();
  });

  it('uses the later of Stripe and grant expiry for effectiveExpiresAt', async () => {
    const { service, deps } = makeService();
    const stripeEnd = new Date('2030-01-01T00:00:00Z');
    const grantEnd = new Date('2031-01-01T00:00:00Z');
    deps.prisma.user.findUnique.mockResolvedValue(
      userRow({
        stripeSubscriptionStatus: 'active',
        stripeSubscriptionPriceId: 'price_premium',
        stripeCurrentPeriodEnd: stripeEnd,
        subscriptionGrants: [grantRow({ endsAt: grantEnd })],
      }),
    );

    const result = await service.recomputeAndApply('u1');

    expect(result.effectiveExpiresAt).toEqual(grantEnd);
  });
});

describe('EntitlementService.setGrantMonths', () => {
  it('throws NotFoundException when the user is missing', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.setGrantMonths({ userId: 'missing', tier: 'premium', months: 1 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('revokes active grants for the tier and creates a consolidated grant', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique
      // setGrantMonths existence check
      .mockResolvedValueOnce({ id: 'u1' })
      // recomputeAndApply read
      .mockResolvedValueOnce(userRow());

    await service.setGrantMonths({
      userId: 'u1',
      tier: 'premium',
      months: 3,
      grantedByAdminId: 'admin1',
      reason: 'support',
    });

    expect(deps.prisma.subscriptionGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', tier: 'premium', revokedAt: null }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(deps.prisma.subscriptionGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tier: 'premium',
          source: 'admin',
          months: 3,
          grantedByAdminId: 'admin1',
          reason: 'support',
        }),
      }),
    );
  });

  it('clears grants entirely when months is 0', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique
      .mockResolvedValueOnce({ id: 'u1' })
      .mockResolvedValueOnce(userRow());

    await service.setGrantMonths({ userId: 'u1', tier: 'premium', months: 0 });

    expect(deps.prisma.subscriptionGrant.updateMany).toHaveBeenCalled();
    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });
});

describe('EntitlementService.extendGrantsAfterPause', () => {
  it('is a no-op when unverifiedAt is null', async () => {
    const { service, deps } = makeService();

    await service.extendGrantsAfterPause('u1', null);

    expect(deps.prisma.subscriptionGrant.findMany).not.toHaveBeenCalled();
  });

  it('extends grant endsAt by the paused duration', async () => {
    const { service, deps } = makeService();
    const pauseMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const unverifiedAt = new Date(Date.now() - pauseMs);
    const endsAt = new Date(Date.now() + 1000);
    deps.prisma.subscriptionGrant.findMany.mockResolvedValue([grantRow({ id: 'g1', endsAt })]);

    await service.extendGrantsAfterPause('u1', unverifiedAt);

    expect(deps.prisma.subscriptionGrant.update).toHaveBeenCalledTimes(1);
    const call = deps.prisma.subscriptionGrant.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'g1' });
    const newEndsAt: Date = call.data.endsAt;
    // Allow a little wall-clock drift between test setup and service execution.
    expect(Math.abs(newEndsAt.getTime() - (endsAt.getTime() + pauseMs))).toBeLessThan(2000);
  });
});

describe('EntitlementService.getGrantSummary', () => {
  it('sums remaining time per tier and rounds to months', async () => {
    const { service, deps } = makeService();
    const now = Date.now();
    const oneMonthMs = 30.44 * 24 * 60 * 60 * 1000;
    deps.prisma.subscriptionGrant.findMany.mockResolvedValue([
      grantRow({ tier: 'premium', endsAt: new Date(now + oneMonthMs) }),
      grantRow({ id: 'g2', tier: 'premiumPlus', endsAt: new Date(now + 2 * oneMonthMs) }),
    ]);

    const summary = await service.getGrantSummary('u1');

    expect(summary.premiumMonthsRemaining).toBe(1);
    expect(summary.premiumPlusMonthsRemaining).toBe(2);
  });

  it('returns zeros when there are no active grants', async () => {
    const { service, deps } = makeService();
    deps.prisma.subscriptionGrant.findMany.mockResolvedValue([]);

    const summary = await service.getGrantSummary('u1');

    expect(summary).toEqual({ premiumMonthsRemaining: 0, premiumPlusMonthsRemaining: 0 });
  });
});
