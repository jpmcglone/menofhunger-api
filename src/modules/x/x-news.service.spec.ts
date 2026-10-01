import { XNewsService, mapXNews } from "./x-news.service";

describe("shared news experiment", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(start + 3600_000);
  });
  afterEach(() => jest.useRealTimers());
  function harness() {
    const news = {
      enabled: true,
      pilotStart: new Date(start).toISOString(),
      accountUserId: "company",
      query: "selected topic",
      requestMaxMicros: 100_000,
      priceVersion: "confirmed-test",
    };
    const budgets = {
      reserve: jest.fn(async () => true),
      settle: jest.fn(async () => undefined),
    };
    const redis = {
      withLock: jest.fn(async (_key, _opts, work) => work()),
      setJson: jest.fn(),
      getJson: jest.fn(async () => null),
    };
    const api = { getNews: jest.fn(async () => ({ data: [] })) };
    const config = {
      xNews: () => news,
      integrationBudget: () => ({
        enabled: true,
        sharedMonthlyMicros: 20_000_000,
      }),
      runSchedulers: () => true,
    };
    const effects = { dispatch: jest.fn() };
    const service = new XNewsService(
      config as any,
      redis as any,
      budgets as any,
      {
        getActiveConnection: async () => ({ xUserId: "123" }),
        accessTokenFor: async () => "token",
      } as any,
      api as any,
      {} as any,
      effects as any,
    );
    return { news, budgets, redis, api, service, effects };
  }
  it("viewing never calls the provider or schedules work", async () => {
    const h = harness();
    await h.service.get();
    expect(h.api.getNews).not.toHaveBeenCalled();
    expect(h.effects.dispatch).not.toHaveBeenCalled();
  });
  it("reserves the smaller of $10 or 10% of reserve and a fourteen-request lifetime", async () => {
    const h = harness();
    await h.service.refresh(`${start}-0`);
    expect(h.budgets.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "reserve", maximumMicros: 100_000 }),
      expect.objectContaining({
        actionLifetimeMicros: 2_000_000,
        actionLifetimeRequests: 14,
      }),
    );
    expect(h.api.getNews).toHaveBeenCalledTimes(1);
  });
  it("stops after seven days and ignores stale queue slots", async () => {
    const h = harness();
    await h.service.refresh(`${start}-1`);
    jest.setSystemTime(start + 7 * 86_400_000);
    await h.service.refresh(`${start}-14`);
    await h.service.schedule();
    expect(h.api.getNews).not.toHaveBeenCalled();
    expect(h.effects.dispatch).not.toHaveBeenCalled();
  });
  it("does not call unknown-price or unfunded endpoints", async () => {
    const h = harness();
    h.news.priceVersion = "";
    await h.service.refresh(`${start}-0`);
    h.news.priceVersion = "confirmed";
    h.budgets.reserve.mockResolvedValue(false);
    await h.service.refresh(`${start}-0`);
    expect(h.api.getNews).not.toHaveBeenCalled();
  });
  it("retains source attribution, deduplicates, and rejects arbitrary URLs", () => {
    const item = {
      id: "story",
      name: "Title",
      cluster_posts_results: [{ post_id: "123" }],
      disclaimer: "AI summary",
    };
    expect(
      mapXNews({
        data: [
          item,
          item,
          {
            ...item,
            id: "other",
            cluster_posts_results: [{ post_id: "javascript:alert(1)" }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "story",
        title: "Title",
        summary: null,
        sourceUrl: "https://x.com/i/status/123",
        disclaimer: "AI summary",
      },
    ]);
  });
});
