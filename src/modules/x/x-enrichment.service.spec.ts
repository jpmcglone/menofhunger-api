import { XProfilePreviewService } from "./x-profile-preview.service";
import { XAuthorMetricsService } from "./x-author-metrics.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";

import { PostsReadService } from '../posts-read/posts-read.service';
function harness() {
  const cache = new Map<string, unknown>();
  const held = new Set<string>();
  const redis = {
    getJson: jest.fn(async (key: string) => cache.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    raw: () => ({ eval: jest.fn(async () => 1) }),
    withLock: jest.fn(
      async (key: string, _options: unknown, body: () => Promise<unknown>) => {
        if (held.has(key)) return null;
        held.add(key);
        try {
          return await body();
        } finally {
          held.delete(key);
        }
      },
    ),
  };
  const policy = {
    enabled: true,
    profilePreviewEnabled: true,
    profileContextEnabled: true,
    priceVersion: X_REFERENCE_PRICES.version,
  };
  const config = { integrationBudget: () => policy };
  const prisma = {
    user: {
      findFirst: jest.fn(async () => ({
        xUsername: "hunter",
        xConnection: { xUserId: "123", username: "hunter", status: "active" },
      })),
    },
    post: { findFirst: jest.fn(async () => ({ id: "post" })) },
    xCrosspost: {
      findUnique: jest.fn(async () => ({
        id: "copy",
        userId: "author",
        remoteId: "987",
        lastError: null,
      })),
      findMany: jest.fn(async () => [{ id: "copy" }]),
    },
  };
  const budgets = {
    reserve: jest.fn(async () => true),
    settle: jest.fn(async () => undefined),
  };
  const connections = {
    getActiveConnection: jest.fn(async (id: string) => ({
      xUserId: id,
      generation: `${id}-generation`,
    })),
    accessTokenFor: jest.fn(async () => "private-token"),
  };
  const profile = {
    id: "123",
    username: "hunter",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const api = {
    getPublicProfileByUsername: jest.fn(async () => profile),
    getPublicProfile: jest.fn(async () => profile),
    getPublicPostMetrics: jest.fn(async () => ({ likes: 0 })),
    getProfileContext: jest.fn(async () => ({
      targetId: "123",
      followsYou: true,
      following: false,
      messageUrl: "https://x.com/messages/compose?recipient_id=123",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    })),
  };
  return {
    cache,
    redis,
    policy,
    config,
    prisma,
    budgets,
    connections,
    api,
    profile,
    previews: new XProfilePreviewService(
      prisma as any,
      redis as any,
      config as any,
      budgets as any,
      api as any,
      connections as any,
      {
        profile: jest.fn(async () => null),
        metrics: jest.fn(async () => null),
        saveProfile: jest.fn(),
        saveMetrics: jest.fn(),
        invalidate: jest.fn(),
      } as any,
    ),
    metrics: new XAuthorMetricsService(prisma as any,
      redis as any,
      config as any,
      budgets as any,
      api as any,
      connections as any,
      {
        profile: jest.fn(async () => null),
        metrics: jest.fn(async () => null),
        saveProfile: jest.fn(),
        saveMetrics: jest.fn(),
        invalidate: jest.fn(),
      } as any, new PostsReadService(prisma as any as never)),
  };
}

describe("paid profile enrichment", () => {
  it("shares one public read across viewers without charging the profile owner", async () => {
    const h = harness();
    await h.previews.get("viewer-a", "profile");
    await h.previews.get("viewer-b", "profile");
    expect(h.api.getPublicProfile).toHaveBeenCalledTimes(1);
    expect(h.budgets.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "reserve", maximumMicros: 10_000 }),
      h.policy,
    );
    expect(h.budgets.reserve).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.any(String) }),
      expect.anything(),
    );
    expect(h.prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          blocksInitiated: { none: { blockedId: "viewer-b" } },
          blocksReceived: { none: { blockerId: "viewer-b" } },
        }),
      }),
    );
  });
  it("resolves a manually saved handle once and shares its immutable-ID cache", async () => {
    const h = harness();
    h.prisma.user.findFirst.mockResolvedValue({
      xUsername: "hunter",
      xConnection: null,
    } as any);
    expect(await h.previews.get("viewer-a", "profile")).toEqual(h.profile);
    expect(await h.previews.get("viewer-b", "profile")).toEqual(h.profile);
    expect(h.api.getPublicProfileByUsername).toHaveBeenCalledTimes(1);
    expect(h.api.getPublicProfile).not.toHaveBeenCalled();
    expect(h.cache.get("x:profile-id:v1:hunter")).toBe("123");
  });
  it("does not enrich a removed or blocked MOH profile, including from shared cache", async () => {
    const h = harness();
    h.cache.set("x:public-profile:v1:123", { profile: h.profile });
    h.prisma.user.findFirst.mockResolvedValue(null as any);
    expect(await h.previews.get("viewer", "profile")).toBeNull();
    expect(h.api.getPublicProfile).not.toHaveBeenCalled();
  });
  it("coalesces concurrent cold requests to one upstream call", async () => {
    const h = harness();
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        h.previews.get(`viewer${n}`, "profile"),
      ),
    );
    expect(h.api.getPublicProfile).toHaveBeenCalledTimes(1);
  });
  it("does not fetch when reserve is exhausted and never serves an expired snapshot", async () => {
    const h = harness();
    h.cache.set("x:public-profile:v1:123", {
      profile: { ...h.profile, expiresAt: "2000-01-01Z" },
    });
    h.budgets.reserve.mockResolvedValue(false);
    expect(await h.previews.get("viewer", "profile")).toBeNull();
    expect(h.api.getPublicProfile).not.toHaveBeenCalled();
  });
  it("fails closed if locking is unavailable", async () => {
    const h = harness();
    h.redis.withLock.mockRejectedValue(new Error("redis unavailable"));
    expect(await h.previews.get("viewer", "profile")).toBeNull();
    expect(h.api.getPublicProfile).not.toHaveBeenCalled();
  });
  it("negative-caches failure and retains the uncertain charge", async () => {
    const h = harness();
    h.api.getPublicProfile.mockRejectedValue(new Error("timeout"));
    await h.previews.get("viewer", "profile");
    await h.previews.get("viewer", "profile");
    expect(h.api.getPublicProfile).toHaveBeenCalledTimes(1);
    expect(h.budgets.settle).toHaveBeenCalledWith(
      expect.any(String),
      "uncertain",
    );
    expect(h.budgets.settle).not.toHaveBeenCalledWith(
      expect.any(String),
      "released",
    );
  });
  it("keeps DM permissions private to the viewer and connection generation", async () => {
    const h = harness();
    await h.previews.context("a", "profile");
    await h.previews.context("a", "profile");
    await h.previews.context("b", "profile");
    expect(h.api.getProfileContext).toHaveBeenCalledTimes(2);
    expect([...h.cache.keys()]).toContain(
      "x:profile-context:v1:a-generation:a:123",
    );
    expect([...h.cache.keys()]).toContain(
      "x:profile-context:v1:b-generation:b:123",
    );
    expect(h.cache.get("x:public-profile:v1:123")).toEqual({
      profile: h.profile,
    });
  });
  it("does not fetch viewer context before account validation enables it", async () => {
    const h = harness();
    h.policy.profileContextEnabled = false;
    expect(await h.previews.context("a", "profile")).toBeNull();
    expect(h.connections.getActiveConnection).not.toHaveBeenCalled();
  });
});

describe("bounded author metrics", () => {
  it("requires local ownership before reading even a cached snapshot", async () => {
    const h = harness();
    h.prisma.post.findFirst.mockResolvedValue(null as any);
    expect(await h.metrics.get("reader", "post")).toBeNull();
    expect(h.redis.getJson).not.toHaveBeenCalled();
    expect(h.prisma.post.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "reader",
          visibility: "public",
          deletedAt: null,
        }),
      }),
    );
  });
  it("limits fresh requests to the recent twenty copies", async () => {
    const h = harness();
    h.prisma.xCrosspost.findMany.mockResolvedValue([]);
    expect(await h.metrics.get("author", "post")).toBeNull();
    expect(h.prisma.xCrosspost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
    expect(h.budgets.reserve).not.toHaveBeenCalled();
  });
  it("reuses a public snapshot even when no further budget is available", async () => {
    const h = harness();
    const result = await h.metrics.get("author", "post");
    h.budgets.reserve.mockResolvedValue(false);
    expect(await h.metrics.get("author", "post")).toEqual(result);
    expect(h.api.getPublicPostMetrics).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ likes: 0 });
    expect(result).not.toHaveProperty("impressions");
    expect(h.budgets.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "author",
        action: "analytics",
        bucket: "regular",
        maximumMicros: 5_000,
      }),
      h.policy,
    );
  });
});
