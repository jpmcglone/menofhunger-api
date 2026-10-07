import { AdminServiceStatusService } from "./admin-service-status.service";

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ models: { list: jest.fn(async () => ({})) } })),
}));

type Opts = {
  env?: Record<string, string>;
  prod?: boolean;
  dbOk?: boolean;
  redisOk?: boolean;
  typeSafeProbe?: any;
  typeSafeHealth?: any;
};

function make(opts: Opts = {}) {
  const env = opts.env ?? {};
  const appConfig: any = {
    envIsSet: (name: string) => Boolean(env[name]),
    isProd: () => opts.prod ?? true,
    nodeEnv: () => (opts.prod ?? true ? "production" : "development"),
    disableTwilioInDev: () => false,
    callsSfuEnabled: () => false,
    marvBot: () => ({ enabled: true }),
    marvOpenAI: () => ({ apiKey: env.OPENAI_API_KEY ?? "" }),
    appleIap: () => null,
    r2: () => null,
    typeSafe: () => ({
      model: "jev-latest",
      routingEnabled: true,
      replyGateEnabled: false,
      triageEnabled: true,
    }),
  };
  const prisma: any = {
    $queryRaw: jest.fn(async () => {
      if (opts.dbOk === false) throw new Error("connection refused");
      return [];
    }),
  };
  const redis: any = {
    raw: () => ({
      ping: async () => {
        if (opts.redisOk === false) throw new Error("ECONNREFUSED");
      },
    }),
  };
  const typeSafe: any = {
    probe: jest.fn(async () => opts.typeSafeProbe ?? null),
    healthSnapshot: () => opts.typeSafeHealth ?? { consecutiveFailures: 0, lastFailure: null },
  };
  return new AdminServiceStatusService(appConfig, prisma, redis, typeSafe);
}

const find = (report: any, id: string) => report.services.find((s: any) => s.id === id);

describe("AdminServiceStatusService", () => {
  it("reports connected core services as green", async () => {
    const report = await make({ env: { DATABASE_URL: "x", SESSION_HMAC_SECRET: "s", OTP_HMAC_SECRET: "o" } }).report({ refresh: true });
    expect(find(report, "database")).toMatchObject({ level: "green", state: "connected", checkedLive: true });
    expect(find(report, "redis")).toMatchObject({ level: "green", state: "connected" });
    expect(find(report, "auth-secrets")).toMatchObject({ level: "green", state: "configured", checkedLive: false });
  });

  it("marks a configured but unreachable critical service red with the error", async () => {
    const report = await make({ env: { DATABASE_URL: "x" }, dbOk: false, redisOk: false }).report({ refresh: true });
    expect(find(report, "database")).toMatchObject({ level: "red", state: "failing", detail: "connection refused" });
    expect(find(report, "redis")).toMatchObject({ level: "red", state: "failing" });
    expect(report.overall).toBe("red");
    expect(report.counts.red).toBeGreaterThanOrEqual(2);
  });

  it("lists missing setting names but never any values", async () => {
    const report = await make({ env: { STRIPE_SECRET_KEY: "sk_live_secret_value" } }).report({ refresh: true });
    const stripe = find(report, "stripe");
    expect(stripe).toMatchObject({ level: "red", state: "partial" });
    expect(stripe.missingKeys).toEqual(["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PREMIUM_MONTHLY", "STRIPE_PRICE_PREMIUM_PLUS_MONTHLY"]);
    expect(JSON.stringify(report)).not.toContain("sk_live_secret_value");
  });

  it("treats an unset required service as yellow in development, red in production", async () => {
    const prod = await make({ prod: true }).report({ refresh: true });
    expect(find(prod, "stripe")).toMatchObject({ level: "red", state: "not_configured" });
    const dev = await make({ prod: false }).report({ refresh: true });
    expect(find(dev, "stripe")).toMatchObject({ level: "yellow", state: "not_configured" });
  });

  it("shows Jev as yellow, not red, when missing and says what falls back", async () => {
    const report = await make().report({ refresh: true });
    const jev = find(report, "typesafe");
    expect(jev).toMatchObject({ level: "yellow", state: "not_configured", missingKeys: ["TYPESAFE_API_KEY"] });
    expect(jev.impact).toMatch(/keyword rules/);
    expect(jev.features).toEqual(expect.arrayContaining([{ label: "Reply gate", enabled: false }]));
  });

  it("shows Jev as connected when the probe succeeds and yellow when the key is rejected", async () => {
    const ok = await make({ env: { TYPESAFE_API_KEY: "k" }, typeSafeProbe: { ok: true, latencyMs: 42, models: ["jev-1.13.0"] } }).report({ refresh: true });
    expect(find(ok, "typesafe")).toMatchObject({ level: "green", state: "connected", latencyMs: 42 });
    const bad = await make({ env: { TYPESAFE_API_KEY: "k" }, typeSafeProbe: { ok: false, latencyMs: 9, error: "401 Unauthorized", status: 401 } }).report({ refresh: true });
    expect(find(bad, "typesafe")).toMatchObject({ level: "yellow", state: "failing", detail: "401 Unauthorized" });
  });

  it("flags Jev when recent decision calls keep failing even though the probe passes", async () => {
    const report = await make({
      env: { TYPESAFE_API_KEY: "k" },
      typeSafeProbe: { ok: true, latencyMs: 5, models: [] },
      typeSafeHealth: { consecutiveFailures: 4, lastFailure: "timed out" },
    }).report({ refresh: true });
    expect(find(report, "typesafe")).toMatchObject({ level: "yellow", state: "failing", detail: "timed out" });
  });

  it("caches briefly and rate limits forced refreshes", async () => {
    const svc = make();
    const first = await svc.report();
    expect(await svc.report()).toBe(first);
    expect(await svc.report({ refresh: true })).toBe(first);
  });
});
