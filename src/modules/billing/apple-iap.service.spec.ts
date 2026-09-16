import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { AppleIapService } from './apple-iap.service';

const APPLE_CFG = {
  bundleId: 'com.menofhunger.app',
  issuerId: 'issuer-id',
  keyId: 'key-id',
  privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  productTierMap: { 'com.menofhunger.premium.monthly': 'premium' as const },
  environment: 'sandbox' as const,
  appAppleId: null,
};

function makeDeps(appleIapCfg: unknown = APPLE_CFG) {
  return {
    prisma: {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(async () => null),
        update: jest.fn(async (_params: any) => ({})),
      },
    },
    appConfig: { appleIap: jest.fn(() => appleIapCfg) },
    entitlement: { recomputeAndApply: jest.fn(async () => undefined) },
    billing: { getMe: jest.fn(async () => ({})) },
    referral: { maybeGrantReferralBonus: jest.fn(async () => undefined) },
  };
}

function makeService(appleIapCfg: unknown = APPLE_CFG) {
  const deps = makeDeps(appleIapCfg);
  const service = new AppleIapService(
    deps.prisma as any,
    deps.appConfig as any,
    deps.entitlement as any,
    deps.billing as any,
    deps.referral as any,
  );
  return { service, deps };
}

/** A structurally valid-looking but NOT Apple-signed JWS. Real verification must reject this. */
function forgedJws(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = enc({ alg: 'ES256', x5c: ['not-a-real-cert'] });
  const body = enc(payload);
  const sig = Buffer.from('forged-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('AppleIapService', () => {
  it('throws ServiceUnavailable when Apple IAP is not configured', async () => {
    const { service } = makeService(null);
    await expect(service.verifyTransaction('u1', forgedJws({}))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a transaction JWS that is not signed by Apple', async () => {
    const { service, deps } = makeService();
    const forged = forgedJws({
      type: 'Auto-Renewable Subscription',
      productId: 'com.menofhunger.premium.monthly',
      originalTransactionId: 'txn-123',
      environment: 'Sandbox',
    });

    await expect(service.verifyTransaction('u1', forged)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    // Nothing is persisted or entitled when the signature can't be verified.
    expect(deps.prisma.user.update).not.toHaveBeenCalled();
    expect(deps.entitlement.recomputeAndApply).not.toHaveBeenCalled();
  });

  it('ignores an App Store notification that is not signed by Apple', async () => {
    const { service, deps } = makeService();
    const forged = forgedJws({ notificationType: 'DID_RENEW', data: {} });

    await expect(service.handleNotification(forged)).resolves.toBeUndefined();
    expect(deps.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(deps.prisma.user.update).not.toHaveBeenCalled();
  });
});


describe('Apple review transaction delivery', () => {
  const transaction = { type: 'Auto-Renewable Subscription', productId: 'com.menofhunger.premium.monthly', originalTransactionId: 'sandbox-123', environment: 'Sandbox', expiresDate: Date.now() + 86400000 };
  it('accepts Apple-verified Sandbox purchases in production without financial rewards', async () => {
    const { service, deps } = makeService({ ...APPLE_CFG, environment: 'production', appAppleId: 123 });
    jest.spyOn(service as any, 'verifyAgainstEnvironments').mockResolvedValue(transaction);
    await service.verifyTransaction('u1', 'verified-by-Apple');
    expect(deps.prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: expect.objectContaining({ appleSandboxOriginalTransactionId: 'sandbox-123', appleSandboxStatus: 'active' }) });
    expect(deps.prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('appleOriginalTransactionId');
    expect(deps.entitlement.recomputeAndApply).toHaveBeenCalledWith('u1');
    expect(deps.referral.maybeGrantReferralBonus).not.toHaveBeenCalled();
  });
  it('rejects a verified transaction already owned by another account', async () => {
    const { service, deps } = makeService();
    jest.spyOn(service as any, 'verifyAgainstEnvironments').mockResolvedValue(transaction);
    deps.prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });
    await expect(service.verifyTransaction('u1', 'verified-by-Apple')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(deps.prisma.user.update).not.toHaveBeenCalled();
  });
  it('does not activate a revoked transaction even if its expiry is in the future', async () => {
    const { service, deps } = makeService();
    jest.spyOn(service as any, 'verifyAgainstEnvironments').mockResolvedValue({ ...transaction, revocationDate: Date.now() });
    await service.verifyTransaction('u1', 'verified-by-Apple');
    expect(deps.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ appleSandboxStatus: 'expired' }) }));
  });
});

describe('Apple purchase lifecycle recovery', () => {
  const txn = {
    type: 'Auto-Renewable Subscription', productId: 'com.menofhunger.premium.monthly',
    originalTransactionId: 'synthetic-lifecycle', environment: 'Sandbox',
    expiresDate: Date.parse('2030-10-16T00:00:00Z'),
  };
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2030-09-16T00:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each([
    ['DID_RENEW', undefined, 'active'],
    ['EXPIRED', undefined, 'expired'],
    ['REFUND', Date.parse('2030-09-16T00:00:00Z'), 'expired'],
    ['REVOKE', Date.parse('2030-09-16T00:00:00Z'), 'expired'],
    ['DID_CHANGE_RENEWAL_STATUS', undefined, 'active'],
  ])('handles %s without financial rewards in sandbox', async (notificationType, revocationDate, expected) => {
    const { service, deps } = makeService();
    deps.prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
    jest.spyOn(service as any, 'verifyAgainstEnvironments')
      .mockResolvedValueOnce({ notificationType, data: { environment: 'Sandbox', signedTransactionInfo: 'synthetic' } })
      .mockResolvedValueOnce({ ...txn, revocationDate });
    await service.handleNotification('synthetic-signed-notification');
    expect(deps.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ appleSandboxStatus: expected }) }));
    expect(deps.entitlement.recomputeAndApply).toHaveBeenCalledWith('u1');
    expect(deps.referral.maybeGrantReferralBonus).not.toHaveBeenCalled();
  });

  it('recovers after persistence succeeded but entitlement activation timed out', async () => {
    const { service, deps } = makeService();
    jest.spyOn(service as any, 'verifyAgainstEnvironments').mockResolvedValue(txn);
    deps.entitlement.recomputeAndApply.mockRejectedValueOnce(new Error('temporary outage'));
    await expect(service.verifyTransaction('u1', 'synthetic')).rejects.toThrow('temporary outage');
    expect(deps.billing.getMe).not.toHaveBeenCalled();
    await expect(service.verifyTransaction('u1', 'synthetic')).resolves.toEqual({});
    expect(deps.entitlement.recomputeAndApply).toHaveBeenCalledTimes(2);
    expect(deps.prisma.user.update.mock.calls[0]).toEqual(deps.prisma.user.update.mock.calls[1]);
    expect(deps.referral.maybeGrantReferralBonus).not.toHaveBeenCalled();
  });

  it('rejects unknown products without persistence or entitlement changes', async () => {
    const { service, deps } = makeService();
    jest.spyOn(service as any, 'verifyAgainstEnvironments').mockResolvedValue({ ...txn, productId: 'unknown' });
    await expect(service.verifyTransaction('u1', 'synthetic')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(deps.prisma.user.update).not.toHaveBeenCalled();
    expect(deps.entitlement.recomputeAndApply).not.toHaveBeenCalled();
  });
});
