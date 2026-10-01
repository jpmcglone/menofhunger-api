import {
  IntegrationBudgetService,
  integrationCommittedCost,
  type IntegrationSpendPolicy,
} from "./integration-budget.service";
import { integrationLimits } from "./integration-budget.policy";

const now = new Date("2026-10-01T12:00:00Z");
const policy: IntegrationSpendPolicy = {
  enabled: true,
  priceVersion: "verified-test",
  companyMonthlyMicros: 100_000_000,
  companyDailyMicros: 20_000_000,
  providerMonthlyMicros: 100_000_000,
  sharedMonthlyMicros: 2_000_000,
};
function harness(
  initial: any[] = [],
  member = {
    premium: true,
    premiumPlus: true,
    verifiedStatus: "manual",
    bannedAt: null,
  },
) {
  const rows = initial;
  const lock = jest.fn();
  const tx = {
    $executeRaw: lock,
    integrationSpendControl: { findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      if (sql.join("").includes("integration:lifetime")) {
        // The embedded CASE is a Prisma.Sql value followed by query parameters.
        const [provider, action, excluded] = values.slice(-3);
        const entries = rows.filter(
          (r) =>
            r.provider === provider && r.action === action && r.id !== excluded,
        );
        return [
          {
            cost: entries.reduce((n, r) => n + integrationCommittedCost(r), 0),
            requests: entries.filter((r) => r.status !== "released").length,
          },
        ];
      }
      const [month, day, excluded, provider, owner, identity, bucket] = values;
      const entries = rows.filter(
        (r) => r.month.getTime() === month.getTime() && r.id !== excluded,
      );
      const own = (r: any) =>
        Boolean(
          (owner && r.userId === owner) ||
          (identity &&
            r.provider === provider &&
            r.externalAccountId === identity),
        );
      const sum = (filter: (r: any) => boolean) =>
        entries
          .filter(filter)
          .reduce((n, r) => n + integrationCommittedCost(r), 0);
      return [
        {
          company: sum(() => true),
          daily: sum((r) => r.createdAt >= day),
          provider: sum((r) => r.provider === provider),
          bucket: sum(
            (r) =>
              r.bucket === bucket &&
              (["reserve", "acquisition"].includes(bucket) || own(r)),
          ),
          analytics: sum((r) => own(r) && r.action === "analytics"),
          publications: entries
            .filter(
              (r) => own(r) && r.provider === "x" && r.status !== "released",
            )
            .reduce((n, r) => n + r.publicationCount, 0),
          regular: sum((r) => own(r) && r.bucket === "regular"),
          expensive: sum((r) => own(r) && r.bucket === "expensive"),
          pendingRegular: sum(
            (r) =>
              own(r) &&
              r.bucket === "regular" &&
              ["reserved", "uncertain"].includes(r.status),
          ),
          pendingExpensive: sum(
            (r) =>
              own(r) &&
              r.bucket === "expensive" &&
              ["reserved", "uncertain"].includes(r.status),
          ),
        },
      ];
    }),
    user: { findUnique: jest.fn(async () => member) },
    integrationUsageReservation: {
      findUnique: jest.fn(
        async ({ where }) => rows.find((row) => row.id === where.id) ?? null,
      ),
      findMany: jest.fn(async ({ where }) =>
        rows.filter(
          (row) =>
            (!where.month || row.month.getTime() === where.month.getTime()) &&
            row.id !== where.id?.not &&
            (!where.provider || row.provider === where.provider) &&
            (!where.action || row.action === where.action),
        ),
      ),
      upsert: jest.fn(async ({ where, create, update }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        if (index < 0) rows.push(create);
        else rows[index] = { ...rows[index], ...update };
      }),
    },
  };
  // Serial transaction fake asserts decisions across competing reservations. The
  // production implementation additionally uses PostgreSQL advisory locking.
  let tail = Promise.resolve();
  const prisma = {
    $transaction: (body: (tx: any) => Promise<boolean>) => {
      const result = tail.then(() => body(tx));
      tail = result.then(() => undefined);
      return result;
    },
  };
  return { service: new IntegrationBudgetService(prisma as any), rows, lock };
}
const create = {
  id: "operation",
  userId: "member",
  externalAccountId: "external",
  provider: "x" as const,
  action: "create",
  bucket: "expensive" as const,
  maximumMicros: 200_000,
  publicationCount: 1,
};
const historical = (overrides: Record<string, unknown> = {}) => ({
  ...create,
  reservedMicros: 200_000,
  chargedMicros: null,
  month: new Date("2026-10-01Z"),
  createdAt: now,
  status: "settled",
  priceVersion: policy.priceVersion,
  ...overrides,
});

describe("shared integration budgets", () => {
  it("gives both paid tiers the same regular budget and publication ceiling", () => {
    expect(
      integrationLimits({
        verified: true,
        premium: true,
        premiumPlus: false,
        banned: false,
      }),
    ).toEqual({
      regular: 8_000_000,
      expensive: 0,
      analytics: 1_000_000,
      xPublications: 300,
    });
  });
  it("rejects expensive actions for Premium and all spending for a banned account", async () => {
    const premium = harness([], {
      premium: true,
      premiumPlus: false,
      verifiedStatus: "manual",
      bannedAt: null,
    });
    expect(await premium.service.reserve(create, policy, now)).toBe(false);
  });
  it("shares the expensive pool across providers and prevents concurrent overspend", async () => {
    const { service, rows, lock } = harness([
      historical({
        id: "other",
        provider: "linkedin",
        reservedMicros: 9_800_000,
      }),
    ]);
    expect(
      await Promise.all(
        ["a", "b"].map((id) => service.reserve({ ...create, id }, policy, now)),
      ),
    ).toEqual([true, false]);
    expect(rows).toHaveLength(2);
    expect(lock).toHaveBeenCalledTimes(2);
  });
  it("authorizes exactly one worker for the same operation", async () => {
    const { service } = harness();
    expect(
      await Promise.all([
        service.reserve(create, policy, now),
        service.reserve(create, policy, now),
      ]),
    ).toEqual([true, false]);
  });
  it("retains spend through external identity changes and across account switching", async () => {
    const { service } = harness([
      historical({ userId: "old-member", reservedMicros: 10_000_000 }),
    ]);
    expect(await service.reserve({ ...create, id: "new" }, policy, now)).toBe(
      false,
    );
  });
  it("does not borrow the regular pool for expensive usage", async () => {
    const { service } = harness([historical({ reservedMicros: 10_000_000 })]);
    expect(await service.reserve({ ...create, id: "new" }, policy, now)).toBe(
      false,
    );
  });
  it("retains uncertain cost and never authorizes resending an uncertain create", async () => {
    const { service } = harness([historical({ status: "uncertain" })]);
    expect(await service.reserve(create, policy, now)).toBe(false);
    expect(
      integrationCommittedCost({
        status: "uncertain",
        reservedMicros: 200_000,
        chargedMicros: 0,
      }),
    ).toBe(200_000);
  });
  it("does not refund a vendor charge when the user reservation is released", () => {
    expect(
      integrationCommittedCost({
        status: "released",
        reservedMicros: 200_000,
        chargedMicros: 5_000,
      }),
    ).toBe(5_000);
  });
  it("blocks company, daily, provider and shared caps independently", async () => {
    for (const key of [
      "companyMonthlyMicros",
      "companyDailyMicros",
      "providerMonthlyMicros",
    ] as const) {
      expect(
        await harness().service.reserve(
          create,
          { ...policy, [key]: 199_999 },
          now,
        ),
      ).toBe(false);
    }
    expect(
      await harness().service.reserve(
        {
          ...create,
          userId: undefined,
          publicationCount: 0,
          bucket: "reserve",
        },
        { ...policy, sharedMonthlyMicros: 199_999 },
        now,
      ),
    ).toBe(false);
  });
  it("never bills a public refresh to the profile owner", async () => {
    expect(
      await harness().service.reserve(
        { ...create, bucket: "reserve" },
        policy,
        now,
      ),
    ).toBe(false);
  });
  it("preserves the 300-post ceiling including thread slots", async () => {
    const { service } = harness([
      historical({ id: "thread", reservedMicros: 1, publicationCount: 299 }),
    ]);
    expect(
      await service.reserve({ ...create, publicationCount: 2 }, policy, now),
    ).toBe(false);
  });
  it("rejects unconfirmed prices, disabled spending and fractional costs", async () => {
    const { service } = harness();
    expect(
      await service.reserve(create, { ...policy, priceVersion: "" }, now),
    ).toBe(false);
    expect(
      await service.reserve(create, { ...policy, enabled: false }, now),
    ).toBe(false);
    await expect(
      service.reserve({ ...create, maximumMicros: 0.5 }, policy, now),
    ).rejects.toThrow();
  });
  it("keeps a pilot lifetime cap across the UTC month reset", async () => {
    const { service } = harness([
      historical({
        id: "prior-month",
        month: new Date("2026-09-01Z"),
        action: "news:pilot",
        bucket: "reserve",
        userId: null,
        reservedMicros: 200_000,
      }),
    ]);
    expect(
      await service.reserve(
        {
          ...create,
          id: "next",
          userId: undefined,
          action: "news:pilot",
          bucket: "reserve",
          publicationCount: 0,
        },
        { ...policy, actionLifetimeMicros: 399_999 },
        now,
      ),
    ).toBe(false);
  });
  it("rechecks a held reservation against downgraded entitlements", async () => {
    const { service } = harness([historical({ status: "reserved" })], {
      premium: true,
      premiumPlus: false,
      verifiedStatus: "manual",
      bannedAt: null,
    });
    expect(await service.reserve(create, policy, now)).toBe(false);
  });
});
