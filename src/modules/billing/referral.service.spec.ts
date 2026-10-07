import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  function recruit(overrides: Record<string, unknown> = {}) {
    return {
      id: 'recruit1',
      verifiedStatus: 'identity',
      referralBonusGrantedAt: null,
      recruitedById: 'recruiter1',
      recruitedBy: { id: 'recruiter1', bannedAt: null },
      ...overrides,
    };
  }

  it('grants both the recruiter and the recruit, with no paid plan required', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit());

    await service.maybeGrantReferralBonus('recruit1');

    const grantCalls = deps.prisma.subscriptionGrant.create.mock.calls as any[];
    expect(grantCalls.map((c) => c[0].data.userId).sort()).toEqual(['recruit1', 'recruiter1']);
    for (const call of grantCalls) {
      expect(call[0].data.requiresActiveSubscription).toBe(false);
      expect(call[0].data.source).toBe('referral');
    }
    expect(deps.entitlement.recomputeAndApply).toHaveBeenCalledTimes(2);
  });

  it('does nothing until the recruit is verified', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit({ verifiedStatus: 'none' }));

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.user.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });

  it('does nothing when the recruiter is banned', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(
      recruit({ recruitedBy: { id: 'recruiter1', bannedAt: new Date() } }),
    );

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });

  it('is idempotent when already marked', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit({ referralBonusGrantedAt: new Date() }));

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
  });

  it('grants exactly once when two verifications race', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit());
    deps.prisma.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    await Promise.all([service.maybeGrantReferralBonus('recruit1'), service.maybeGrantReferralBonus('recruit1')]);

    expect(deps.prisma.subscriptionGrant.create).toHaveBeenCalledTimes(2);
    expect(deps.sideEffects.dispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches referral.bonus.granted', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit());

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.sideEffects.dispatch).toHaveBeenCalledWith('referral.bonus.granted', {
      recruitId: 'recruit1',
      recruiterId: 'recruiter1',
    });
  });

  it('does nothing when the recruit has no recruiter', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(recruit({ recruitedById: null, recruitedBy: null }));

    await service.maybeGrantReferralBonus('recruit1');

    expect(deps.prisma.subscriptionGrant.create).not.toHaveBeenCalled();
    expect(deps.sideEffects.dispatch).not.toHaveBeenCalled();
  });
});

describe('ReferralService.recordPremiumMilestone', () => {
  it('records the affiliate premium milestone and never throws', async () => {
    const { service, deps } = makeService();
    deps.affiliate.maybeRecordEarning.mockRejectedValueOnce(new Error('boom'));
    await expect(service.recordPremiumMilestone('recruit1')).resolves.toBeUndefined();
    expect(deps.affiliate.maybeRecordEarning).toHaveBeenCalledWith('recruit1', 'premium');
  });
});

// ─── ensureCode ───────────────────────────────────────────────────────────────

describe('ReferralService.ensureCode', () => {
  it('derives an uppercase code from the username', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      username: 'John_Doe', referralCode: null, verifiedStatus: 'identity', premium: false,
    });

    await expect(service.ensureCode('u1')).resolves.toBe('JOHN_DOE');
    expect(deps.prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', referralCode: null },
      data: { referralCode: 'JOHN_DOE' },
    });
  });

  it('retries with a numeric suffix on a unique collision', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      username: 'johndoe', referralCode: null, verifiedStatus: 'manual', premium: false,
    });
    deps.prisma.user.updateMany
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.ensureCode('u1')).resolves.toBe('JOHNDOE2');
  });

  it('keeps an existing code and skips unverified members', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValueOnce({
      username: 'johndoe', referralCode: 'MINE', verifiedStatus: 'identity', premium: false,
    });
    await expect(service.ensureCode('u1')).resolves.toBe('MINE');

    deps.prisma.user.findUnique.mockResolvedValueOnce({
      username: 'johndoe', referralCode: null, verifiedStatus: 'none', premium: false,
    });
    await expect(service.ensureCode('u2')).resolves.toBeNull();
    expect(deps.prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe('ReferralService.lookupPublicInviter', () => {
  it('returns the inviter display fields for an active code', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findFirst.mockResolvedValue({
      username: 'john', name: 'John', premium: false, verifiedStatus: 'identity',
      avatarKey: null, avatarUpdatedAt: null,
    });

    await expect(service.lookupPublicInviter('john')).resolves.toEqual({
      username: 'john', name: 'John', avatarUrl: null,
    });
    expect(deps.prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { referralCode: 'JOHN', bannedAt: null } }),
    );
  });

  it('404s for unknown, malformed, or unverified codes', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.lookupPublicInviter('nobody')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.lookupPublicInviter('!!')).rejects.toBeInstanceOf(NotFoundException);

    deps.prisma.user.findFirst.mockResolvedValue({
      username: 'x', name: 'X', premium: false, verifiedStatus: 'none', avatarKey: null, avatarUpdatedAt: null,
    });
    await expect(service.lookupPublicInviter('xcode')).rejects.toBeInstanceOf(NotFoundException);
  });
});
