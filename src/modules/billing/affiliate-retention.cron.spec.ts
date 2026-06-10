import { AffiliateRetentionCron } from './affiliate-retention.cron';
import { AFFILIATE_PREMIUM_RETENTION_DAYS } from './affiliate.service';

function makePrisma(): any {
  return {
    user: { findMany: jest.fn() },
  };
}

function makeAppConfig(run = true): any {
  return { runSchedulers: jest.fn().mockReturnValue(run) };
}

function makeAffiliate(): any {
  return { maybeRecordEarning: jest.fn().mockResolvedValue({ affiliateUserId: 'recruiter-1' }) };
}

function makeCron(prisma = makePrisma(), appConfig = makeAppConfig(), affiliate = makeAffiliate()) {
  return new AffiliateRetentionCron(prisma, appConfig, affiliate);
}

describe('AffiliateRetentionCron.runCheckRetention', () => {
  it('does nothing when runSchedulers returns false', async () => {
    const prisma = makePrisma();
    const appConfig = makeAppConfig(false);
    const affiliate = makeAffiliate();
    const cron = new AffiliateRetentionCron(prisma, appConfig, affiliate);

    await cron.checkRetention();

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(affiliate.maybeRecordEarning).not.toHaveBeenCalled();
  });

  it('calls maybeRecordEarning(recruitId, premium60d) for each eligible recruit', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'recruit-a' }, { id: 'recruit-b' }]);
    const affiliate = makeAffiliate();
    const cron = makeCron(prisma, makeAppConfig(true), affiliate);

    await cron.runCheckRetention();

    expect(affiliate.maybeRecordEarning).toHaveBeenCalledTimes(2);
    expect(affiliate.maybeRecordEarning).toHaveBeenCalledWith('recruit-a', 'premium60d');
    expect(affiliate.maybeRecordEarning).toHaveBeenCalledWith('recruit-b', 'premium60d');
  });

  it('does nothing when no eligible recruits are found', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValueOnce([]);
    const affiliate = makeAffiliate();
    const cron = makeCron(prisma, makeAppConfig(true), affiliate);

    await cron.runCheckRetention();

    expect(affiliate.maybeRecordEarning).not.toHaveBeenCalled();
  });

  it('queries with referralBonusGrantedAt cutoff of 60 days ago', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValueOnce([]);
    const cron = makeCron(prisma);

    const before = Date.now();
    await cron.runCheckRetention();
    const after = Date.now();

    const call = prisma.user.findMany.mock.calls[0][0];
    const cutoff: Date = call.where.referralBonusGrantedAt.lte;
    const expectedMs = AFFILIATE_PREMIUM_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - expectedMs - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - expectedMs + 100);
  });

  it('continues processing remaining recruits if one fails', async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'fail-1' }, { id: 'ok-2' }]);
    const affiliate = makeAffiliate();
    affiliate.maybeRecordEarning
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({ affiliateUserId: 'recruiter-1' });
    const cron = makeCron(prisma, makeAppConfig(true), affiliate);

    await expect(cron.runCheckRetention()).resolves.not.toThrow();
    expect(affiliate.maybeRecordEarning).toHaveBeenCalledTimes(2);
  });
});
