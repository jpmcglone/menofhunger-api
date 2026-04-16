import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

// ─── Stripe mock ─────────────────────────────────────────────────────────────
// BillingService calls `require('stripe')` inside getStripe(). We replace it
// with a constructor that returns whatever the current test suite stashed on
// `global.__stripeMock__`, so each test can swap the behavior.

type StripeMock = {
  checkout: { sessions: { create: jest.Mock } };
  billingPortal: { sessions: { create: jest.Mock } };
  customers: { create: jest.Mock };
  subscriptions: { retrieve: jest.Mock; update: jest.Mock };
  webhooks: { constructEvent: jest.Mock };
};

declare global {
  // eslint-disable-next-line no-var
  var __stripeMock__: StripeMock | undefined;
}

jest.mock('stripe', () => {
  return function StripeCtor() {
    if (!global.__stripeMock__) throw new Error('stripe mock not configured');
    return global.__stripeMock__;
  };
});

function makeStripeMock(): StripeMock {
  return {
    checkout: { sessions: { create: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    customers: { create: jest.fn() },
    subscriptions: { retrieve: jest.fn(), update: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  };
}

// ─── Deps factory ────────────────────────────────────────────────────────────

type Deps = {
  prisma: any;
  appConfig: any;
  publicProfileCache: any;
  usersMeRealtime: any;
  usersPublicRealtime: any;
  posthog: any;
  slack: any;
  entitlement: any;
  referral: any;
};

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    prisma: {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(async () => ({})),
        findUniqueOrThrow: jest.fn(async () => ({ id: 'u1', username: 'u' })),
      },
      stripeWebhookEvent: { create: jest.fn(async () => ({})) },
      subscriptionGrant: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    },
    appConfig: {
      stripe: jest.fn(() => ({
        secretKey: 'sk_test',
        webhookSecret: 'whsec',
        frontendBaseUrl: 'https://example.test',
        pricePremiumMonthly: 'price_premium',
        pricePremiumPlusMonthly: 'price_premium_plus',
      })),
      r2: jest.fn(() => ({ publicBaseUrl: 'https://cdn.example.test' })),
      nodeEnv: jest.fn(() => 'development'),
    },
    publicProfileCache: { invalidateForUser: jest.fn(async () => undefined) },
    usersMeRealtime: { emitMeUpdated: jest.fn(async () => undefined) },
    usersPublicRealtime: { emitPublicProfileUpdated: jest.fn(async () => undefined) },
    posthog: { capture: jest.fn() },
    slack: { notifyPremiumGranted: jest.fn() },
    entitlement: {
      getActiveGrants: jest.fn(async () => []),
      recomputeAndApply: jest.fn(async () => ({
        isPremium: true,
        isPremiumPlus: false,
        effectiveTier: 'premium',
        grantExpiresAt: null,
        stripeExpiresAt: null,
      })),
      extendGrantsAfterPause: jest.fn(async () => undefined),
    },
    referral: { maybeGrantReferralBonus: jest.fn(async () => undefined) },
    ...overrides,
  };
}

function makeService(overrides: Partial<Deps> = {}) {
  const deps = makeDeps(overrides);
  const service = new BillingService(
    deps.prisma,
    deps.appConfig,
    deps.publicProfileCache,
    deps.usersMeRealtime,
    deps.usersPublicRealtime,
    deps.posthog,
    deps.slack,
    deps.entitlement,
    deps.referral,
  );
  return { service, deps };
}

beforeEach(() => {
  global.__stripeMock__ = makeStripeMock();
});

afterEach(() => {
  global.__stripeMock__ = undefined;
  jest.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BillingService.getStripe configuration guard', () => {
  it('throws ServiceUnavailableException when Stripe is not configured', async () => {
    const { service } = makeService({
      appConfig: {
        stripe: jest.fn(() => null),
        r2: jest.fn(() => null),
        nodeEnv: jest.fn(() => 'test'),
      },
    });

    await expect(service.createPortalSession({ userId: 'u1' })).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('BillingService.getMe', () => {
  it('returns billing state with grants and recruiter info', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      premium: true,
      premiumPlus: false,
      verifiedStatus: 'identity',
      stripeSubscriptionStatus: 'active',
      stripeCancelAtPeriodEnd: false,
      stripeCurrentPeriodEnd: new Date('2030-01-01T00:00:00Z'),
      referralCode: 'ABC123',
      referralBonusGrantedAt: null,
      recruitedBy: null,
      _count: { recruits: 0 },
    });
    deps.entitlement.getActiveGrants.mockResolvedValue([]);

    const me = await service.getMe('u1');

    expect(me.premium).toBe(true);
    expect(me.premiumPlus).toBe(false);
    expect(me.verified).toBe(true);
    expect(me.subscriptionStatus).toBe('active');
    expect(me.currentPeriodEnd).toBe('2030-01-01T00:00:00.000Z');
    expect(me.referralCode).toBe('ABC123');
    expect(me.recruiter).toBeNull();
    expect(me.recruitCount).toBe(0);
  });

  it('throws NotFoundException when user is missing', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getMe('missing')).rejects.toThrow(NotFoundException);
  });
});

describe('BillingService.createCheckoutSession', () => {
  it('rejects unverified users', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.test',
      verifiedStatus: 'none',
      premium: false,
      premiumPlus: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionPriceId: null,
    });

    await expect(
      service.createCheckoutSession({ userId: 'u1', tier: 'premium' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects duplicate Premium subscription', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.test',
      verifiedStatus: 'identity',
      premium: true,
      premiumPlus: false,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripeSubscriptionStatus: 'active',
      stripeSubscriptionPriceId: 'price_premium',
    });

    await expect(
      service.createCheckoutSession({ userId: 'u1', tier: 'premium' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects Premium downgrade from Premium+ via checkout', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.test',
      verifiedStatus: 'identity',
      premium: true,
      premiumPlus: true,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripeSubscriptionStatus: 'active',
      stripeSubscriptionPriceId: 'price_premium_plus',
    });

    await expect(
      service.createCheckoutSession({ userId: 'u1', tier: 'premium' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates a checkout session for a new subscriber', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.test',
      verifiedStatus: 'identity',
      premium: false,
      premiumPlus: false,
      stripeCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: null,
      stripeSubscriptionPriceId: null,
    });
    global.__stripeMock__!.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.test/session_123',
    });

    const result = await service.createCheckoutSession({ userId: 'u1', tier: 'premium' });

    expect(result.url).toBe('https://checkout.stripe.test/session_123');
    expect(global.__stripeMock__!.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_existing',
        client_reference_id: 'u1',
        line_items: [{ price: 'price_premium', quantity: 1 }],
      }),
    );
  });
});

describe('BillingService.createPortalSession', () => {
  it('rejects users without a Stripe customer', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      stripeCustomerId: null,
      verifiedStatus: 'identity',
    });

    await expect(service.createPortalSession({ userId: 'u1' })).rejects.toThrow(BadRequestException);
  });

  it('returns portal URL for a verified user with a customer', async () => {
    const { service, deps } = makeService();
    deps.prisma.user.findUnique.mockResolvedValue({
      stripeCustomerId: 'cus_1',
      verifiedStatus: 'identity',
    });
    global.__stripeMock__!.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://billing.stripe.test/portal_123',
    });

    const result = await service.createPortalSession({ userId: 'u1' });

    expect(result.url).toBe('https://billing.stripe.test/portal_123');
  });
});

describe('BillingService.devResetPremium', () => {
  it('rejects outside development', async () => {
    const { service } = makeService({
      appConfig: {
        stripe: jest.fn(() => ({
          secretKey: 'sk_test', webhookSecret: 'whsec', frontendBaseUrl: 'x',
          pricePremiumMonthly: 'p', pricePremiumPlusMonthly: 'pp',
        })),
        r2: jest.fn(() => null),
        nodeEnv: jest.fn(() => 'production'),
      },
    });

    await expect(service.devResetPremium('u1')).rejects.toThrow(ForbiddenException);
  });
});

// ─── Webhook tests ───────────────────────────────────────────────────────────

describe('BillingService.handleWebhook', () => {
  const rawBody = Buffer.from('raw');
  const sig = 't=123,v1=abc';

  it('throws BadRequestException when signature verification fails', async () => {
    const { service } = makeService();
    global.__stripeMock__!.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });

    await expect(
      service.handleWebhook({ rawBody, stripeSignature: sig }),
    ).rejects.toThrow(BadRequestException);
  });

  it('is a no-op on duplicate event (P2002)', async () => {
    const { service, deps } = makeService();
    global.__stripeMock__!.webhooks.constructEvent.mockReturnValue({
      id: 'evt_dup',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });
    deps.prisma.stripeWebhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      } as any),
    );

    await expect(
      service.handleWebhook({ rawBody, stripeSignature: sig }),
    ).resolves.toBeUndefined();
    expect(deps.prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('syncs subscription on checkout.session.completed', async () => {
    const { service, deps } = makeService();
    global.__stripeMock__!.webhooks.constructEvent.mockReturnValue({
      id: 'evt_cs',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });
    deps.prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      name: 'Alice',
      verifiedStatus: 'identity',
      premium: false,
      premiumPlus: false,
      recruitedById: null,
      referralBonusGrantedAt: null,
    });
    global.__stripeMock__!.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1_000_000,
      current_period_end: 2_000_000,
      items: { data: [{ price: { id: 'price_premium' } }] },
    });

    await service.handleWebhook({ rawBody, stripeSignature: sig });

    expect(deps.prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          stripeSubscriptionId: 'sub_1',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPriceId: 'price_premium',
          stripeCancelAtPeriodEnd: false,
        }),
      }),
    );
    expect(deps.entitlement.recomputeAndApply).toHaveBeenCalledWith('u1');
    expect(deps.slack.notifyPremiumGranted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tier: 'premium', source: 'stripe' }),
    );
  });

  it('is a no-op when customer does not map to a user', async () => {
    const { service, deps } = makeService();
    global.__stripeMock__!.webhooks.constructEvent.mockReturnValue({
      id: 'evt_unknown',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_missing',
          status: 'active',
          items: { data: [{ price: { id: 'price_premium' } }] },
        },
      },
    });
    deps.prisma.user.findFirst.mockResolvedValue(null);

    await service.handleWebhook({ rawBody, stripeSignature: sig });

    expect(deps.prisma.user.update).not.toHaveBeenCalled();
    expect(deps.entitlement.recomputeAndApply).not.toHaveBeenCalled();
  });

  it('ignores unrelated event types without side effects', async () => {
    const { service, deps } = makeService();
    global.__stripeMock__!.webhooks.constructEvent.mockReturnValue({
      id: 'evt_unrelated',
      type: 'product.created',
      data: { object: {} },
    });

    await service.handleWebhook({ rawBody, stripeSignature: sig });

    expect(deps.prisma.user.findFirst).not.toHaveBeenCalled();
    expect(deps.entitlement.recomputeAndApply).not.toHaveBeenCalled();
  });
});
