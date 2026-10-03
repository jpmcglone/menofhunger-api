import { ConfigService } from "@nestjs/config";
import { AppConfigService } from "../app/app-config.service";
import {
  LOCAL_BILLING_ACCOUNT,
  LocalBillingTestService,
} from "./local-billing-test.service";

const future = new Date(Date.now() + 3600000).toISOString();
const purchase = {
  entitlements: [
    { productId: "com.menofhunger.premium.monthly", expiresAt: future },
  ],
};
function fixture(overrides = {}) {
  const config = new AppConfigService(
    new ConfigService({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/moh",
      MOH_LOCAL_BILLING_TESTS: "1",
      ...overrides,
    }),
  );
  const user = {
    ...LOCAL_BILLING_ACCOUNT,
    accountKind: "person",
    verifiedStatus: "manual",
  };
  const prisma = {
    user: { findUnique: jest.fn(async () => user) },
    subscriptionGrant: { upsert: jest.fn(), updateMany: jest.fn() },
  };
  const entitlements = { recomputeAndApply: jest.fn() };
  const billing = { getMe: jest.fn(async () => ({ premium: true })) };
  return {
    user,
    prisma,
    entitlements,
    billing,
    service: new LocalBillingTestService(
      config,
      prisma as any,
      entitlements as any,
      billing as any,
    ),
  };
}
describe("local billing simulation", () => {
  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "test" },
    { MOH_LOCAL_BILLING_TESTS: "0" },
    { MOH_LOCAL_BILLING_TESTS: undefined },
    { DATABASE_URL: "postgresql://db.example.com/moh" },
    { DATABASE_URL: "invalid" },
  ])("fails closed for %p before reading the account", async (config) => {
    const f = fixture(config);
    await expect(
      f.service.sync(LOCAL_BILLING_ACCOUNT.id, "127.0.0.1", purchase),
    ).rejects.toThrow();
    expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(f.prisma.subscriptionGrant.upsert).not.toHaveBeenCalled();
  });
  it.each(["192.168.1.2", undefined])(
    "rejects non-loopback clients (%p)",
    async (address) => {
      const f = fixture();
      await expect(
        f.service.sync(LOCAL_BILLING_ACCOUNT.id, address, purchase),
      ).rejects.toThrow();
      expect(f.prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );
  it("rejects other identities and unverified fixture accounts", async () => {
    const f = fixture();
    await expect(f.service.sync("other", "::1", purchase)).rejects.toThrow();
    f.user.verifiedStatus = "none";
    await expect(
      f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", purchase),
    ).rejects.toThrow();
    expect(f.prisma.subscriptionGrant.upsert).not.toHaveBeenCalled();
  });
  it("activates a labelled grant and recomputes through normal billing", async () => {
    const f = fixture();
    await expect(
      f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", purchase),
    ).resolves.toEqual({ data: { premium: true } });
    expect(f.prisma.subscriptionGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tier: "premium",
          source: "admin",
          reason: expect.stringContaining("SIMULATED"),
        }),
      }),
    );
    expect(f.entitlements.recomputeAndApply).toHaveBeenCalledWith(
      LOCAL_BILLING_ACCOUNT.id,
    );
  });
  it("restores idempotently, selects Premium+, and revokes only its own grant on expiry/reset", async () => {
    const f = fixture();
    const snapshot = {
      entitlements: [
        ...purchase.entitlements,
        { productId: "com.menofhunger.premiumplus.monthly", expiresAt: future },
      ],
    };
    await f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", snapshot);
    await f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", snapshot);
    expect(f.prisma.subscriptionGrant.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: `local-storekit:${LOCAL_BILLING_ACCOUNT.id}` },
        update: expect.objectContaining({ tier: "premiumPlus" }),
      }),
    );
    await f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", { entitlements: [] });
    expect(f.prisma.subscriptionGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: `local-storekit:${LOCAL_BILLING_ACCOUNT.id}`,
        userId: LOCAL_BILLING_ACCOUNT.id,
      },
      data: { revokedAt: expect.any(Date) },
    });
  });
  it.each([
    { entitlements: [{ productId: "unknown", expiresAt: future }] },
    {
      entitlements: [
        { productId: purchase.entitlements[0].productId, expiresAt: "invalid" },
      ],
    },
    { signedTransaction: "not-a-receipt" },
  ])("rejects malformed snapshots", async (body) => {
    const f = fixture();
    await expect(
      f.service.sync(LOCAL_BILLING_ACCOUNT.id, "::1", body),
    ).rejects.toThrow();
    expect(f.prisma.subscriptionGrant.upsert).not.toHaveBeenCalled();
  });
});
