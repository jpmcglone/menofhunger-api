import { BillingService } from './billing.service';
import { contractFixtures } from '../../common/dto/contract-fixtures';

describe('billing wire contract consumed by web and iOS', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2030-09-16T00:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each(Object.entries(contractFixtures.billing))('serializes %s membership', async (_name, expected) => {
    const row = {
      premium: expected.premium, premiumPlus: expected.premiumPlus,
      verifiedStatus: expected.verified ? 'identity' : 'none',
      stripeSubscriptionStatus: expected.subscriptionStatus,
      stripeCancelAtPeriodEnd: expected.cancelAtPeriodEnd,
      stripeCurrentPeriodEnd: expected.currentPeriodEnd ? new Date(expected.currentPeriodEnd) : null,
      appleStatus: expected.source === 'apple' ? 'active' : null,
      appleExpiresAt: expected.appleExpiresAt ? new Date(expected.appleExpiresAt) : null,
      referralCode: null, referralBonusGrantedAt: null, recruitedBy: null, _count: { recruits: 0 },
    };
    const service = new BillingService(
      { user: { findUnique: jest.fn().mockResolvedValue(row) } } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      { getActiveGrants: jest.fn().mockResolvedValue(expected.grants.map(grant => ({ ...grant, startsAt: new Date(grant.startsAt), endsAt: new Date(grant.endsAt) }))) } as any,
      {} as any,
    );
    expect(await service.getMe('synthetic-user')).toEqual(expected);
  });
});
