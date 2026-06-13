/**
 * E2E: Stripe webhook → entitlement flow.
 *
 * Boots a minimal Nest HTTP app with the real BillingController, BillingService,
 * and EntitlementService (Prisma and side-effect services mocked), then POSTs a
 * genuinely-signed Stripe event to /billing/webhook and asserts the subscription
 * state is persisted and the user's effective tier is recomputed.
 *
 * Signature verification is real: we sign the payload with the same webhook
 * secret the service is configured with, using Stripe's own test-header helper.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as express from 'express';
import * as request from 'supertest';
import { BillingController } from '../src/modules/billing/billing.controller';
import { BillingService } from '../src/modules/billing/billing.service';
import { EntitlementService } from '../src/modules/billing/entitlement.service';
import { ReferralService } from '../src/modules/billing/referral.service';
import { AffiliateService } from '../src/modules/billing/affiliate.service';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AppConfigService } from '../src/modules/app/app-config.service';
import { PublicProfileCacheService } from '../src/modules/users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../src/modules/users/users-me-realtime.service';
import { UsersPublicRealtimeService } from '../src/modules/users/users-public-realtime.service';
import { PosthogService } from '../src/common/posthog/posthog.service';
import { SlackService } from '../src/common/slack/slack.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';

const WEBHOOK_SECRET = 'whsec_test_secret';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const StripeCtor = require('stripe');
const stripeForSigning = new StripeCtor('sk_test_signing_only');

function signedHeaderFor(payload: string): string {
  return stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
}

function makePrismaMock() {
  return {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(async () => ({})),
    },
    stripeWebhookEvent: {
      findUnique: jest.fn(async (): Promise<{ processedAt: Date | null } | null> => null),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
    },
  };
}

describe('POST /billing/webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof makePrismaMock>;
  let slack: { notifyPremiumGranted: jest.Mock };
  let posthog: { capture: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    slack = { notifyPremiumGranted: jest.fn() };
    posthog = { capture: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [
        BillingService,
        EntitlementService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AppConfigService,
          useValue: {
            stripe: () => ({
              secretKey: 'sk_test_app',
              webhookSecret: WEBHOOK_SECRET,
              frontendBaseUrl: 'https://example.test',
              pricePremiumMonthly: 'price_premium',
              pricePremiumPlusMonthly: 'price_premium_plus',
            }),
            r2: () => null,
            nodeEnv: () => 'test',
          },
        },
        { provide: PublicProfileCacheService, useValue: { invalidateForUser: jest.fn(async () => undefined) } },
        { provide: UsersMeRealtimeService, useValue: { emitMeUpdated: jest.fn(async () => undefined) } },
        { provide: UsersPublicRealtimeService, useValue: { emitPublicProfileUpdated: jest.fn(async () => undefined) } },
        { provide: PosthogService, useValue: posthog },
        { provide: SlackService, useValue: slack },
        { provide: ReferralService, useValue: { maybeGrantReferralBonus: jest.fn(async () => undefined) } },
        { provide: AffiliateService, useValue: { getAffiliateSummary: jest.fn(async () => undefined) } },
      ],
    })
      // The webhook route is unauthenticated; other routes on this controller use
      // AuthGuard, which we stub out so the testing module doesn't need AuthService.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => false })
      .compile();

    // Mirror main.ts: capture the raw body so Stripe signature verification works.
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function subscriptionUpdatedPayload(): string {
    return JSON.stringify({
      id: 'evt_test_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          object: 'subscription',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: 1_750_000_000,
          current_period_end: 1_752_600_000,
          items: { data: [{ price: { id: 'price_premium' } }] },
        },
      },
    });
  }

  it('rejects requests without a stripe-signature header', async () => {
    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('content-type', 'application/json')
      .send(subscriptionUpdatedPayload())
      .expect(400);
  });

  it('rejects requests with an invalid signature', async () => {
    const payload = subscriptionUpdatedPayload();
    const header = signedHeaderFor(payload);
    const tampered = payload.replace('price_premium', 'price_evil_xx');

    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', header)
      .send(tampered)
      .expect(400);

    expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('persists Stripe state and recomputes entitlement on customer.subscription.updated', async () => {
    const payload = subscriptionUpdatedPayload();

    // BillingService.syncSubscriptionToUser: map customer → user.
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      username: 'alice',
      name: 'Alice',
      verifiedStatus: 'identity',
      premium: false,
      premiumPlus: false,
      recruitedById: null,
      referralBonusGrantedAt: null,
    });
    // EntitlementService.recomputeAndApply: read post-sync state.
    prisma.user.findUnique.mockResolvedValue({
      verifiedStatus: 'identity',
      stripeSubscriptionStatus: 'active',
      stripeSubscriptionPriceId: 'price_premium',
      stripeCurrentPeriodEnd: new Date(1_752_600_000 * 1000),
      subscriptionGrants: [],
    });

    const res = await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', signedHeaderFor(payload))
      .send(payload)
      .expect(201);

    expect(res.body).toEqual({ data: { received: true } });

    // 1) Stripe subscription state persisted to the user row.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          stripeSubscriptionId: 'sub_1',
          stripeSubscriptionStatus: 'active',
          stripeSubscriptionPriceId: 'price_premium',
          stripeCancelAtPeriodEnd: false,
          stripeCurrentPeriodEnd: new Date(1_752_600_000 * 1000),
        }),
      }),
    );

    // 2) Entitlement recompute applied the effective tier.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { premium: true, premiumPlus: false },
    });

    // 3) First-time premium triggers the Slack notification + analytics.
    expect(slack.notifyPremiumGranted).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tier: 'premium', source: 'stripe' }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      'u1',
      'tier_changed',
      expect.objectContaining({ is_premium: true }),
    );
  });

  it('skips already-processed events (processedAt set) without reprocessing', async () => {
    const payload = subscriptionUpdatedPayload();
    prisma.stripeWebhookEvent.findUnique.mockResolvedValue({ processedAt: new Date() });

    const res = await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('content-type', 'application/json')
      .set('stripe-signature', signedHeaderFor(payload))
      .send(payload)
      .expect(201);

    expect(res.body).toEqual({ data: { received: true } });
    expect(prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
