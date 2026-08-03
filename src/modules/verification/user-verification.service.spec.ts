import { UserVerificationService } from './user-verification.service';

type Deps = {
  prisma: any;
  billing: any;
  affiliate: any;
  coins: any;
  sideEffects: any;
  publicProfileCache: any;
  usersMeRealtime: any;
  usersPublicRealtime: any;
  presenceRealtime: any;
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    prisma: {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(async () => ({})),
      },
      verificationRequest: {
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          user: { update: jest.fn(async () => ({})) },
          verificationRequest: { updateMany: jest.fn(async () => ({ count: 0 })) },
        }),
      ),
    },
    billing: { onUserVerified: jest.fn(async () => undefined) },
    affiliate: { maybeRecordEarning: jest.fn(async () => undefined) },
    coins: { giftVerificationCoins: jest.fn(async () => undefined) },
    sideEffects: { dispatch: jest.fn() },
    publicProfileCache: { invalidateForUser: jest.fn(async () => undefined) },
    usersMeRealtime: { emitMeUpdated: jest.fn(async () => undefined) },
    usersPublicRealtime: { emitPublicProfileUpdated: jest.fn(async () => undefined) },
    presenceRealtime: { emitAdminUpdated: jest.fn() },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new UserVerificationService(
    deps.prisma,
    deps.billing,
    deps.affiliate,
    deps.coins,
    deps.sideEffects,
    deps.publicProfileCache,
    deps.usersMeRealtime,
    deps.usersPublicRealtime,
    deps.presenceRealtime,
  );
  return { service, deps };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('UserVerificationService.verifyUser', () => {
  it('is a no-op for an already-verified user', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      verifiedStatus: 'manual',
      unverifiedAt: null,
    });

    const result = await service.verifyUser({ userId: 'u1', source: 'auto_signup' });

    expect(result).toEqual({
      verified: false,
      alreadyVerified: true,
      userId: 'u1',
      previousUnverifiedAt: null,
    });
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.sideEffects.dispatch).not.toHaveBeenCalled();
    expect(deps.billing.onUserVerified).not.toHaveBeenCalled();
  });

  it('verifies an unverified user, notifies, and emits realtime updates', async () => {
    const { service, deps } = makeService();
    const previousUnverifiedAt = new Date('2026-01-01T00:00:00.000Z');
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      verifiedStatus: 'none',
      unverifiedAt: previousUnverifiedAt,
    });

    const result = await service.verifyUser({ userId: 'u1', source: 'auto_referral' });

    expect(result).toEqual({
      verified: true,
      alreadyVerified: false,
      userId: 'u1',
      previousUnverifiedAt,
    });
    expect(deps.prisma.$transaction).toHaveBeenCalled();
    expect(deps.billing.onUserVerified).toHaveBeenCalledWith('u1', previousUnverifiedAt);
    expect(deps.coins.giftVerificationCoins).toHaveBeenCalledWith('u1', 5);
    expect(deps.affiliate.maybeRecordEarning).toHaveBeenCalledWith('u1', 'verified');
    expect(deps.sideEffects.dispatch).toHaveBeenCalledWith('user.verified', { userId: 'u1' });
    expect(deps.usersPublicRealtime.emitPublicProfileUpdated).toHaveBeenCalledWith('u1');
    expect(deps.usersMeRealtime.emitMeUpdated).toHaveBeenCalledWith('u1', 'verification_status_changed');
  });

  it('emits admin:updated when approving a request', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      verifiedStatus: 'none',
      unverifiedAt: null,
    });

    await service.verifyUser({
      userId: 'u1',
      source: 'admin_request',
      requestId: 'vr1',
      adminUserId: 'a1',
    });

    expect(deps.presenceRealtime.emitAdminUpdated).toHaveBeenCalledWith('a1', {
      kind: 'verification',
      action: 'reviewed',
      id: 'vr1',
    });
  });
});
