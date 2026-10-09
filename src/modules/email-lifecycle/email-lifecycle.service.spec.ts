import {
  EmailLifecycleService,
  APPLE_BILLING_URL,
} from "./email-lifecycle.service";
import type { LifecycleEmailEvent } from "./email-lifecycle.types";

const now = new Date("2026-10-09T18:00:00.000Z");
const approval = new Date(now.getTime() - 60000);
function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant",
    tier: "premium",
    source: "referral",
    startsAt: new Date(now.getTime() - 86400000),
    endsAt: new Date(now.getTime() + 60 * 3600000),
    requiresActiveSubscription: false,
    ...overrides,
  };
}
function harness(overrides: Record<string, unknown> = {}) {
  const user: any = {
    id: "member",
    accountKind: "person",
    isBot: false,
    bannedAt: null,
    email: "member@example.invalid",
    emailVerifiedAt: now,
    name: "Thomas",
    username: "thomas",
    verifiedStatus: "manual",
    verifiedAt: approval,
    premium: false,
    premiumPlus: false,
    stripeSubscriptionStatus: null,
    stripeCurrentPeriodEnd: null,
    stripeCancelAtPeriodEnd: false,
    appleStatus: null,
    appleExpiresAt: null,
    appleAutoRenew: null,
    subscriptionGrants: [],
    ...overrides,
  };
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    verificationRequest: { findUnique: jest.fn() },
    post: { count: jest.fn().mockResolvedValue(0) },
    communityGroup: { count: jest.fn().mockResolvedValue(0) },
    marvinUsageEvent: { count: jest.fn().mockResolvedValue(0) },
  };
  const config: any = {
    frontendBaseUrl: () => "https://menofhunger.com",
    emailBillingNoticesEnabled: () => true,
    stripe: () => ({ pricePremiumPlusMonthly: "plus" }),
    appleIap: () => ({ productTierMap: { "apple.plus": "premiumPlus" } }),
  };
  const email: any = { sendText: jest.fn().mockResolvedValue({ sent: true }) };
  const effects: any = { dispatch: jest.fn() };
  const service = new EmailLifecycleService(
    prisma,
    config,
    email,
    { register: jest.fn() } as any,
    effects,
  );
  return { service, user, prisma, email, effects, config };
}
function event(
  kind: LifecycleEmailEvent["kind"],
  overrides: Partial<LifecycleEmailEvent> = {},
): LifecycleEmailEvent {
  return {
    kind,
    userId: "member",
    eventId: kind === "verified" ? approval.toISOString() : "event",
    occurredAt: now.toISOString(),
    ...overrides,
  };
}
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
});
afterEach(() => {
  jest.useRealTimers();
});

describe("member lifecycle email state and privacy", () => {
  it("combines first verification with a referral Premium grant under the stable verified key", async () => {
    const { service, email, effects } = harness({
      premium: true,
      subscriptionGrants: [grant()],
      referralBonusGrantedAt: now,
    });
    await service.send(event("verified"));
    expect(email.sendText).toHaveBeenCalledTimes(1);
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "lifecycle:verified:member:first",
        category: "transactional",
        replyTo: "hello@menofhunger.com",
        text: expect.stringContaining("Premium"),
      }),
    );
    expect(effects.dispatch).toHaveBeenCalledWith(
      "email.lifecycle",
      expect.objectContaining({ kind: "premiumTip" }),
      expect.objectContaining({ delay: 3 * 86400000 }),
    );
  });
  it("does not duplicate the newly verified recruit reward welcome", async () => {
    const { service, email } = harness({
      premium: true,
      subscriptionGrants: [grant()],
    });
    await service.send(
      event("referralReward", {
        recruitId: "member",
        source: "referral",
        combinedVerification: true,
      }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("still confirms a referral linked later on the same day as a plain verified welcome", async () => {
    const { service, email, prisma } = harness({
      premium: true,
      subscriptionGrants: [grant()],
    });
    prisma.user.findUnique
      .mockResolvedValueOnce(await prisma.user.findUnique())
      .mockResolvedValueOnce({
        name: "Thomas",
        referralBonusGrantedAt: now,
        recruitedById: "recruiter",
      });
    await service.send(
      event("referralReward", { recruitId: "member", source: "referral" }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Your free month is ready." }),
    );
  });
  it("rejects cancelled subscription notices after expiry or a provider period change", async () => {
    const { service, email } = harness({
      stripeSubscriptionId: "subscription",
      stripeCancelAtPeriodEnd: true,
      stripeCurrentPeriodEnd: new Date(now.getTime() - 1),
    });
    await service.send(
      event("cancellation", {
        source: "stripe",
        eventId: `subscription-${new Date(now.getTime() - 1).toISOString()}`,
      }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("allows a real Premium+ Apple upgrade just after verification and routes billing through Apple", async () => {
    const { service, email } = harness({
      premium: true,
      premiumPlus: true,
      appleStatus: "active",
      appleProductId: "apple.plus",
      appleOriginalTransactionId: "apple-origin",
      appleExpiresAt: grant().endsAt,
    });
    await service.send(
      event("premium", {
        source: "apple",
        tier: "premiumPlus",
        eventId: `apple-origin-${grant().endsAt.toISOString()}-premiumPlus`,
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(APPLE_BILLING_URL),
        subject: expect.stringContaining("Premium+"),
      }),
    );
  });
  it("does not advertise sandbox Plus when production access is only Premium", async () => {
    const { service, email } = harness({
      premium: true,
      premiumPlus: true,
      stripeSubscriptionStatus: "active",
      stripeSubscriptionPriceId: "premium",
    });
    await service.send(event("verified"));
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("Premium is ready"),
        text: expect.not.stringContaining("Premium+"),
      }),
    );
  });
  it("suppresses an old approval and a revoked tier before rendering", async () => {
    const { service, email } = harness();
    await service.send(event("verified", { eventId: "older-approval" }));
    await service.send(
      event("premium", { tier: "premiumPlus", source: "grant" }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it.each([
    { accountKind: "page" },
    { bannedAt: now },
    { isBot: true },
    { emailVerifiedAt: null },
  ])("excludes unavailable recipient %j", async (override) => {
    const { service, email } = harness(override);
    await service.send(event("verified"));
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("sends account security to the previous verified address even though the current address is unverified", async () => {
    const { service, email } = harness({
      email: "new@example.invalid",
      emailVerifiedAt: null,
    });
    await service.send(
      event("accountChanged", {
        previousVerifiedEmail: "old@example.invalid",
        changedField: "email",
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "old@example.invalid",
        recipientMode: "previous",
        retrySafe: false,
        text: expect.not.stringContaining("new@example.invalid"),
      }),
    );
  });
  it("never treats absent Apple renewal state as cancellation confirmation", async () => {
    const { service, email } = harness();
    await service.send(event("cancellation", { source: "apple" }));
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("cancels a queued payment notice after the account recovers", async () => {
    const { service, email } = harness({ stripeSubscriptionStatus: "active" });
    await service.send(event("paymentAttention", { source: "stripe" }));
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("describes the paid product rather than a higher gifted tier in payment notices", async () => {
    const { service, email } = harness({
      premium: true,
      premiumPlus: true,
      stripeSubscriptionStatus: "past_due",
      stripeSubscriptionPriceId: "premium",
    });
    await service.send(event("paymentAttention", { source: "stripe" }));
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringContaining("Premium+"),
      }),
    );
  });
  it.each(["grace", "billing_retry"])(
    "delivers confirmed Apple retry state %s with the Apple management link",
    async (appleStatus) => {
      const { service, email } = harness({ appleStatus });
      await service.send(event("paymentAttention", { source: "apple" }));
      expect(email.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(APPLE_BILLING_URL),
        }),
      );
    },
  );
  it("does not suppress Premium+ grant expiry with lower-tier future coverage", async () => {
    const active = grant({ tier: "premiumPlus" });
    const { service, email } = harness({
      premium: true,
      premiumPlus: true,
      subscriptionGrants: [
        grant({
          id: "future",
          startsAt: active.endsAt,
          endsAt: new Date(now.getTime() + 30 * 86400000),
        }),
        active,
      ],
    });
    await service.send(
      event("grantExpiring", {
        grantId: active.id,
        eventId: `grant-expiring-${active.id}-${active.endsAt.toISOString()}`,
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining("Premium+") }),
    );
  });
  it("honors the provider-managed billing opt-out", async () => {
    const { service, email, config } = harness({
      stripeSubscriptionStatus: "past_due",
    });
    config.emailBillingNoticesEnabled = () => false;
    await service.send(event("paymentAttention", { source: "stripe" }));
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("retries provider failures through the handler so mutable state is rechecked", async () => {
    const { service, email } = harness({
      stripeSubscriptionStatus: "past_due",
    });
    email.sendText.mockResolvedValue({
      sent: false,
      retryable: true,
      reason: "email_failed",
    });
    await expect(
      service.send(event("paymentAttention", { source: "stripe" })),
    ).rejects.toThrow("will retry");
  });
  it("does not declare grant access expiring when a future contiguous grant extends it", async () => {
    const active = grant();
    const future = grant({
      id: "future",
      startsAt: active.endsAt,
      endsAt: new Date(now.getTime() + 30 * 86400000),
    });
    const { service, email } = harness({
      premium: true,
      subscriptionGrants: [future, active],
    });
    await service.send(
      event("grantExpiring", {
        grantId: active.id,
        eventId: `grant-expiring-${active.id}-${active.endsAt.toISOString()}`,
      }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
  });
  it("requires an active grant and an unchanged end date, and respects optional onboarding for an expiry notice", async () => {
    const active = grant();
    const { service, email } = harness({
      premium: true,
      subscriptionGrants: [active],
    });
    await service.send(
      event("grantExpiring", { grantId: active.id, eventId: "stale-end-date" }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
    await service.send(
      event("grantExpiring", {
        grantId: active.id,
        eventId: `grant-expiring-${active.id}-${active.endsAt.toISOString()}`,
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "engagement",
        preference: "emailOnboarding",
      }),
    );
  });
  it("does not use a future grant as current welcome access", async () => {
    const { service, email } = harness({
      premium: true,
      subscriptionGrants: [
        grant({ startsAt: new Date(now.getTime() + 86400000) }),
      ],
    });
    await service.send(event("verified"));
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.not.stringContaining("Premium"),
      }),
    );
  });
  it.each(["post", "communityGroup", "marvinUsageEvent"])(
    "cancels the day-three tip after %s activity",
    async (model) => {
      const { service, email, prisma } = harness({ premium: true });
      prisma[model].count.mockResolvedValue(1);
      await service.send(
        event("premiumTip", {
          occurredAt: new Date(now.getTime() - 3 * 86400000).toISOString(),
        }),
      );
      expect(email.sendText).not.toHaveBeenCalled();
    },
  );
  it("sends one optional day-three suggestion only when the selected tools remain unused", async () => {
    const { service, email } = harness({ premium: true });
    await service.send(
      event("premiumTip", {
        occurredAt: new Date(now.getTime() - 3 * 86400000).toISOString(),
      }),
    );
    expect(email.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "engagement",
        preference: "emailOnboarding",
      }),
    );
  });
  it("does not backfill past lifecycle events or very late tips", async () => {
    const { service, email } = harness({ premium: true });
    await service.send(
      event("premium", {
        occurredAt: new Date(now.getTime() - 2 * 86400000).toISOString(),
      }),
    );
    await service.send(
      event("premiumTip", {
        occurredAt: new Date(now.getTime() - 5 * 86400000).toISOString(),
      }),
    );
    expect(email.sendText).not.toHaveBeenCalled();
  });
});
