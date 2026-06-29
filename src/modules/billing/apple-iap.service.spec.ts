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
        update: jest.fn(async () => ({})),
      },
    },
    appConfig: { appleIap: jest.fn(() => appleIapCfg) },
    entitlement: { recomputeAndApply: jest.fn(async () => undefined) },
    billing: { getMe: jest.fn(async () => ({})) },
  };
}

function makeService(appleIapCfg: unknown = APPLE_CFG) {
  const deps = makeDeps(appleIapCfg);
  const service = new AppleIapService(
    deps.prisma as any,
    deps.appConfig as any,
    deps.entitlement as any,
    deps.billing as any,
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
