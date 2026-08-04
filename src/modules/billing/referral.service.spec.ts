import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ReferralService } from './referral.service';

// ─── Test doubles ─────────────────────────────────────────────────────────────

type Deps = {
  prisma: any;
  appConfig: any;
  entitlement: any;
  follows: any;
  affiliate: any;
  sideEffects: any;
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    prisma: {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      subscriptionGrant: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
        aggregate: jest.fn(async () => ({ _sum: { months: 0 } })),
      },
    },
    appConfig: { r2: jest.fn(() => null) },
    entitlement: { recomputeAndApply: jest.fn(async () => ({})) },
    follows: { follow: jest.fn(async () => undefined) },
    affiliate: { maybeRecordEarning: jest.fn(async () => undefined) },
    sideEffects: { dispatch: jest.fn() },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new ReferralService(
    deps.prisma,
    deps.appConfig,
    deps.entitlement,
    deps.follows,
    deps.affiliate,
    deps.sideEffects,
  );
  return { service, deps };
}

afterEach(() => jest.clearAllMocks());

// ─── setReferralCode ──────────────────────────────────────────────────────────

describe('ReferralService.setReferralCode', () => {
  it('allows a verified (non-premium) user to set a code', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      premium: false,
      verifiedStatus: 'identity',
      referralCode: null,
    });
    deps.prisma.user.findFirst.mockResolvedValue(null); // no conflict
    deps.prisma.user.update.mockResolvedValue({});

    const result = await service.setReferralCode('u1', 'MYCODE');
    expect(result).toEqual({ referralCode: 'MYCODE' });
  });

  it('allows a premium user to set a code', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      premium: true,
      verifiedStatus: 'none',
      referralCode: null,
    });
    deps.prisma.user.findFirst.mockResolvedValue(null);
    deps.prisma.user.update.mockResolvedValue({});

    const result = await service.setReferralCode('u1', 'PREM');
    expect(result).toEqual({ referralCode: 'PREM' });
  });

  it('rejects an unverified, non-premium user', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      premium: false,
      verifiedStatus: 'none',
      referralCode: null,
    });

    await expect(service.setReferralCode('u1', 'MYCODE')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('normalizes code to uppercase', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      premium: true,
      verifiedStatus: 'identity',
      referralCode: null,
    });
    deps.prisma.user.findFirst.mockResolvedValue(null);
    deps.prisma.user.update.mockResolvedValue({});

    const result = await service.setReferralCode('u1', 'lowercase');
    expect(result).toEqual({ referralCode: 'LOWERCASE' });
  });
});

// ─── setRecruiter ─────────────────────────────────────────────────────────────

describe('ReferralService.setRecruiter', () => {
  it('accepts a code owned by a verified non-premium user', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ recruitedById: null });
    deps.prisma.user.findFirst.mockResolvedValue({
      id: 'recruiter1',
      username: 'recruiter',
      name: 'Recruiter',
      premium: false,
      verifiedStatus: 'identity',
    });
    deps.prisma.user.update.mockResolvedValue({});

    const result = await service.setRecruiter('u1', 'RCODE');
    expect(result).toEqual({ recruiter: { username: 'recruiter', name: 'Recruiter' } });
  });

  it('rejects a code owned by an unverified, non-premium user', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({ recruitedById: null });
    deps.prisma.user.findFirst.mockResolvedValue({
      id: 'recruiter1',
      username: 'recruiter',
      name: 'Recruiter',
      premium: false,
      verifiedStatus: 'none',
    });

    await expect(service.setRecruiter('u1', 'RCODE')).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── maybeGrantReferralBonus ──────────────────────────────────────────────────

describe('ReferralService.maybeGrantReferralBonus', () => {
  function recruiterWithStripe() {
    return {
      id: 'recruiter1',
      verifiedStatus: 'identity',
      stripeSubscriptionStatus: 'active',
      appleStatus: null,
      appleExpiresAt: null,
    };
  }

  function recruiterNoSubscription() {
    return {
      id: 'recruiter1',
      verifiedStatus: 'identity',
      stripeSubscriptionStatus: null,
      appleStatus: null,
      appleExpiresAt: null,
    };
  }

  it('grants the inviter a month when recruiter is not a paying subscriber', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: recruiterNoSubscription(),
    });

    await service.maybeGrantReferralBonus('recruit1');

    const grantCalls = deps.prisma.subscriptionGrant.create.mock.calls;
    // Exactly 1 grant — to the recruiter (inviter). Recruit gets nothing since recruiter is not paying.
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0][0].data.userId).toBe('recruiter1');
  });

  it('grants both when recruiter is a paying subscriber (Stripe)', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: recruiterWithStripe(),
    });

    await service.maybeGrantReferralBonus('recruit1');

    const grantCalls = deps.prisma.subscriptionGrant.create.mock.calls;
    expect(grantCalls).toHaveLength(2);
    const userIds = grantCalls.map((c: any) => c[0].data.userId);
    expect(userIds).toContain('recruiter1');
    expect(userIds).toContain('recruit1');
  });

  it('issues grants with requiresActiveSubscription: false', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: recruiterWithStripe(),
    });

    await service.maybeGrantReferralBonus('recruit1');

    for (const call of deps.prisma.subscriptionGrant.create.mock.calls as any[]) {
      expect(call[0].data.requiresActiveSubscription).toBe(false);
    }
  });

  it('is idempotent — does not re-grant when already marked', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: new Date(),
      recruitedById: 'recruiter1',
      recruitedBy: recruiterWithStripe(),
    });

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });

  it('is idempotent under a concurrent race (updateMany returns count=0)', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: recruiterWithStripe(),
    });
    deps.prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });

  it('dispatches referral.bonus.granted side effect', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: recruiterWithStripe(),
    });

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.sideEffects.dispatch).toHaveBeenCalledWith('referral.bonus.granted', {
      recruitId: 'recruit1',
      recruiterId: 'recruiter1',
    });
  });

  it('does nothing when the recruit has no recruiter', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: null,
      recruitedBy: null,
    });

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
    expect(deps.sideEffects.dispatch).not.toHaveBeenCalled();
  });

  it('grants when recruiter has active Apple IAP', async () => {
    const { service, deps } = makeService();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'recruit1',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: {
        id: 'recruiter1',
        verifiedStatus: 'identity',
        stripeSubscriptionStatus: null,
        appleStatus: 'active',
        appleExpiresAt: futureDate,
      },
    });

    await service.maybeGrantReferralBonus('recruit1');

    const grantCalls = deps.prisma.subscriptionGrant.create.mock.calls;
    expect(grantCalls).toHaveLength(2);
  });
});
