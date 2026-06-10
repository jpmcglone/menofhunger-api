import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AffiliateService, AFFILIATE_CAP_CENTS, AFFILIATE_MIN_PAYOUT_CENTS, AFFILIATE_RATES_CENTS } from './affiliate.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AFFILIATE_AT = new Date('2026-01-01T00:00:00Z');
const AFTER_AFFILIATE_AT = new Date('2026-02-01T00:00:00Z');
const BEFORE_AFFILIATE_AT = new Date('2025-12-01T00:00:00Z');

function makePrisma(overrides: Record<string, unknown> = {}): any {
  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    affiliateEarning: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
    },
    ...overrides,
  };
}

function makeRealtime(): any {
  return { emitReferralRecruitUpdated: jest.fn() };
}

function makeAppConfig(): any {
  return { r2: () => ({ publicBaseUrl: null }) };
}

function makeSvc(prisma: any, realtime = makeRealtime(), appConfig = makeAppConfig()): AffiliateService {
  return new AffiliateService(prisma, appConfig, realtime);
}

/** Returns a recruit mock where the recruit joined AFTER affiliateAt (qualifies). */
function makeQualifiedRecruitLookup(affiliateAt = AFFILIATE_AT) {
  return {
    createdAt: AFTER_AFFILIATE_AT,
    recruitedById: 'recruiter-1',
    recruitedBy: { id: 'recruiter-1', affiliateAt },
  };
}

// ─── maybeRecordEarning ───────────────────────────────────────────────────────

describe('AffiliateService.maybeRecordEarning', () => {
  it('no-ops when recruit has no recruiter', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ createdAt: AFTER_AFFILIATE_AT, recruitedById: null, recruitedBy: null });
    const svc = makeSvc(prisma);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: null });
    expect(prisma.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('no-ops when recruiter is not an affiliate', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({
      createdAt: AFTER_AFFILIATE_AT,
      recruitedById: 'recruiter-1',
      recruitedBy: { id: 'recruiter-1', affiliateAt: null },
    });
    const svc = makeSvc(prisma);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: null });
    expect(prisma.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('no-ops when recruit joined BEFORE recruiter became a pilot member', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({
      createdAt: BEFORE_AFFILIATE_AT,
      recruitedById: 'recruiter-1',
      recruitedBy: { id: 'recruiter-1', affiliateAt: AFFILIATE_AT },
    });
    const svc = makeSvc(prisma);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: null });
    expect(prisma.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('records signup earning ($1) when recruit joined after affiliateAt', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique
      .mockResolvedValueOnce(makeQualifiedRecruitLookup())
      .mockResolvedValueOnce({
        id: 'recruit-1', username: 'recruit', name: 'Recruit',
        premium: false, premiumPlus: false, isOrganization: false, stewardBadgeEnabled: false,
        verifiedStatus: 'none', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, isBot: false,
        orgMemberships: [], createdAt: AFTER_AFFILIATE_AT, referralBonusGrantedAt: null,
      });
    prisma.affiliateEarning.create.mockResolvedValueOnce({});
    const realtime = makeRealtime();
    const svc = makeSvc(prisma, realtime);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: 'recruiter-1' });
    expect(prisma.affiliateEarning.create).toHaveBeenCalledWith({
      data: {
        affiliateUserId: 'recruiter-1',
        recruitUserId: 'recruit-1',
        type: 'signup',
        amountCents: 100,
      },
    });
  });

  it('records verified earning ($3)', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique
      .mockResolvedValueOnce(makeQualifiedRecruitLookup())
      .mockResolvedValueOnce({
        id: 'recruit-2', username: null, name: null,
        premium: false, premiumPlus: false, isOrganization: false, stewardBadgeEnabled: false,
        verifiedStatus: 'identity', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, isBot: false,
        orgMemberships: [], createdAt: AFTER_AFFILIATE_AT, referralBonusGrantedAt: null,
      });
    prisma.affiliateEarning.create.mockResolvedValueOnce({});
    const svc = makeSvc(prisma);

    await svc.maybeRecordEarning('recruit-2', 'verified');

    expect(prisma.affiliateEarning.create.mock.calls[0][0].data.amountCents).toBe(300);
  });

  it('records premium earning ($10, not $20)', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique
      .mockResolvedValueOnce(makeQualifiedRecruitLookup())
      .mockResolvedValueOnce({
        id: 'recruit-3', username: null, name: null,
        premium: true, premiumPlus: false, isOrganization: false, stewardBadgeEnabled: false,
        verifiedStatus: 'none', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, isBot: false,
        orgMemberships: [], createdAt: AFTER_AFFILIATE_AT, referralBonusGrantedAt: null,
      });
    prisma.affiliateEarning.create.mockResolvedValueOnce({});
    const svc = makeSvc(prisma);

    await svc.maybeRecordEarning('recruit-3', 'premium');

    expect(prisma.affiliateEarning.create.mock.calls[0][0].data.amountCents).toBe(1000);
    expect(AFFILIATE_RATES_CENTS.premium).toBe(1000);
  });

  it('records premium60d earning ($10)', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique
      .mockResolvedValueOnce(makeQualifiedRecruitLookup())
      .mockResolvedValueOnce({
        id: 'recruit-4', username: null, name: null,
        premium: true, premiumPlus: false, isOrganization: false, stewardBadgeEnabled: false,
        verifiedStatus: 'none', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, isBot: false,
        orgMemberships: [], createdAt: AFTER_AFFILIATE_AT, referralBonusGrantedAt: new Date(),
      });
    prisma.affiliateEarning.create.mockResolvedValueOnce({});
    const svc = makeSvc(prisma);

    await svc.maybeRecordEarning('recruit-4', 'premium60d');

    expect(prisma.affiliateEarning.create.mock.calls[0][0].data.amountCents).toBe(1000);
    expect(AFFILIATE_RATES_CENTS.premium60d).toBe(1000);
  });

  it('is idempotent: P2002 unique constraint violation is silently ignored', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(makeQualifiedRecruitLookup());
    const p2002 = Object.assign(new Error('Unique constraint'), { code: 'P2002' });
    prisma.affiliateEarning.create.mockRejectedValueOnce(p2002);
    const svc = makeSvc(prisma);

    await expect(svc.maybeRecordEarning('recruit-1', 'signup')).resolves.toBeDefined();
  });

  it('stops accrual when per-member cap is reached', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(makeQualifiedRecruitLookup());
    // Simulate cap already reached
    prisma.affiliateEarning.aggregate.mockResolvedValueOnce({ _sum: { amountCents: AFFILIATE_CAP_CENTS } });
    const svc = makeSvc(prisma);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: null });
    expect(prisma.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('stops accrual when adding this earning would exceed cap', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(makeQualifiedRecruitLookup());
    // 1 cent away from cap, signup would add 100 cents, total would exceed cap
    prisma.affiliateEarning.aggregate.mockResolvedValueOnce({ _sum: { amountCents: AFFILIATE_CAP_CENTS - 50 } });
    const svc = makeSvc(prisma);

    const result = await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(result).toEqual({ affiliateUserId: null });
    expect(prisma.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('emits realtime event to recruiter after recording earning', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique
      .mockResolvedValueOnce(makeQualifiedRecruitLookup())
      .mockResolvedValueOnce({
        id: 'recruit-1', username: 'u', name: 'N',
        premium: false, premiumPlus: false, isOrganization: false, stewardBadgeEnabled: false,
        verifiedStatus: 'none', avatarKey: null, avatarUpdatedAt: null, bannedAt: null, isBot: false,
        orgMemberships: [], createdAt: AFTER_AFFILIATE_AT, referralBonusGrantedAt: null,
      });
    prisma.affiliateEarning.create.mockResolvedValueOnce({});
    const realtime = makeRealtime();
    const svc = makeSvc(prisma, realtime);

    await svc.maybeRecordEarning('recruit-1', 'signup');

    expect(realtime.emitReferralRecruitUpdated).toHaveBeenCalledWith(
      'recruiter-1',
      expect.objectContaining({ recruit: expect.objectContaining({ id: 'recruit-1' }) }),
    );
  });
});

// ─── getAffiliateSummary ──────────────────────────────────────────────────────

describe('AffiliateService.getAffiliateSummary', () => {
  it('returns { isAffiliate: false } for non-affiliates', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ affiliateAt: null });
    const svc = makeSvc(prisma);

    const result = await svc.getAffiliateSummary('user-1');

    expect(result).toEqual({ isAffiliate: false });
    expect(prisma.affiliateEarning.findMany).not.toHaveBeenCalled();
  });

  it('returns summary with correct totals, counts, and threshold fields', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ affiliateAt: AFFILIATE_AT });
    const now = new Date();
    prisma.affiliateEarning.findMany.mockResolvedValueOnce([
      { id: 'e1', recruitUserId: 'r1', recruit: { username: 'a', name: 'A' }, type: 'signup', amountCents: 100, createdAt: now, settledAt: null },
      { id: 'e2', recruitUserId: 'r1', recruit: { username: 'a', name: 'A' }, type: 'verified', amountCents: 300, createdAt: now, settledAt: null },
      { id: 'e3', recruitUserId: 'r2', recruit: { username: 'b', name: 'B' }, type: 'premium', amountCents: 1000, createdAt: now, settledAt: now },
      { id: 'e4', recruitUserId: 'r2', recruit: { username: 'b', name: 'B' }, type: 'premium60d', amountCents: 1000, createdAt: now, settledAt: null },
    ]);
    const svc = makeSvc(prisma);

    const result = await svc.getAffiliateSummary('affiliate-1');

    expect(result).toMatchObject({
      isAffiliate: true,
      pendingCents: 1400, // 100 + 300 + 1000
      settledCents: 1000,
      totalCents: 2400,
      minPayoutCents: AFFILIATE_MIN_PAYOUT_CENTS,
      capCents: AFFILIATE_CAP_CENTS,
      capReached: false,
      counts: { signups: 1, verified: 1, premium: 1, premium60d: 1 },
    });
  });

  it('sets capReached = true when totalCents >= capCents', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ affiliateAt: AFFILIATE_AT });
    const now = new Date();
    // Simulate exactly at cap
    const earnings = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`, recruitUserId: `r${i}`, recruit: { username: null, name: null },
      type: 'premium', amountCents: 10_000, createdAt: now, settledAt: null,
    }));
    prisma.affiliateEarning.findMany.mockResolvedValueOnce(earnings);
    const svc = makeSvc(prisma);

    const result = await svc.getAffiliateSummary('affiliate-1') as Extract<Awaited<ReturnType<typeof svc.getAffiliateSummary>>, { isAffiliate: true }>;

    expect(result.capReached).toBe(true);
    expect(result.totalCents).toBe(100_000);
  });

  it('throws NotFoundException for unknown user', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const svc = makeSvc(prisma);

    await expect(svc.getAffiliateSummary('ghost')).rejects.toThrow(NotFoundException);
  });
});

// ─── settleAffiliate ─────────────────────────────────────────────────────────

describe('AffiliateService.settleAffiliate', () => {
  it('marks all pending earnings as settled and returns totals', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'aff-1', affiliateAt: AFFILIATE_AT });
    prisma.affiliateEarning.findMany.mockResolvedValueOnce([
      { id: 'e1', amountCents: 3000 },
      { id: 'e2', amountCents: 3000 },
    ]);
    prisma.affiliateEarning.updateMany.mockResolvedValueOnce({ count: 2 });
    const svc = makeSvc(prisma);

    const result = await svc.settleAffiliate('aff-1');

    expect(result).toEqual({ settledCount: 2, settledCents: 6000 });
    expect(prisma.affiliateEarning.updateMany).toHaveBeenCalledWith({
      where: { affiliateUserId: 'aff-1', settledAt: null },
      data: { settledAt: expect.any(Date) },
    });
  });

  it('throws BadRequestException when pending balance is below $50 minimum', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'aff-1', affiliateAt: AFFILIATE_AT });
    prisma.affiliateEarning.findMany.mockResolvedValueOnce([
      { id: 'e1', amountCents: 100 },
      { id: 'e2', amountCents: 300 },
    ]);
    const svc = makeSvc(prisma);

    await expect(svc.settleAffiliate('aff-1')).rejects.toThrow(BadRequestException);
    expect(prisma.affiliateEarning.updateMany).not.toHaveBeenCalled();
  });

  it('throws BadRequestException (not silently returns 0) when there are no pending earnings', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'aff-1', affiliateAt: AFFILIATE_AT });
    prisma.affiliateEarning.findMany.mockResolvedValueOnce([]);
    const svc = makeSvc(prisma);

    await expect(svc.settleAffiliate('aff-1')).rejects.toThrow(BadRequestException);
  });

  it('only marks pending (settledAt: null) earnings', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'aff-1', affiliateAt: AFFILIATE_AT });
    prisma.affiliateEarning.findMany.mockResolvedValueOnce([
      { id: 'e1', amountCents: 5000 },
    ]);
    prisma.affiliateEarning.updateMany.mockResolvedValueOnce({ count: 1 });
    const svc = makeSvc(prisma);

    await svc.settleAffiliate('aff-1');

    expect(prisma.affiliateEarning.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ settledAt: null }) }),
    );
  });
});

// ─── setAffiliateStatus ───────────────────────────────────────────────────────

describe('AffiliateService.setAffiliateStatus', () => {
  it('enables affiliate by setting affiliateAt to now', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
    prisma.user.update.mockResolvedValueOnce({});
    const svc = makeSvc(prisma);

    await svc.setAffiliateStatus('user-1', true);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { affiliateAt: expect.any(Date) },
    });
  });

  it('disables affiliate by setting affiliateAt to null', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'user-1' });
    prisma.user.update.mockResolvedValueOnce({});
    const svc = makeSvc(prisma);

    await svc.setAffiliateStatus('user-1', false);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { affiliateAt: null },
    });
  });

  it('throws NotFoundException for unknown user', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const svc = makeSvc(prisma);

    await expect(svc.setAffiliateStatus('ghost', true)).rejects.toThrow(NotFoundException);
  });
});
