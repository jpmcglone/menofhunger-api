import { ViewerBlockSetsService } from "./viewer-block-sets.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { RedisKeys } from "../redis/redis-keys";

function fixture() {
  const rows = [
    { blockerId: "alice", blockedId: "bob" },
    { blockerId: "carol", blockedId: "alice" },
  ];
  const cache = new Map<string, unknown>();
  const prisma = { userBlock: { findMany: jest.fn(async () => rows) } };
  const redis = {
    getJson: jest.fn(async (key: string) => cache.get(key) ?? null),
    setJson: jest.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const key of keys) cache.delete(key);
      return keys.length;
    }),
  };
  const service = new ViewerBlockSetsService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
  );
  return { service, prisma, redis, rows, cache };
}

describe("ViewerBlockSetsService", () => {
  it("shares both directional relationships across consumers without sharing mutable sets", async () => {
    const { service, prisma, redis } = fixture();
    const first = await service.get("alice");
    expect(first.blockedByViewer).toEqual(new Set(["bob"]));
    expect(first.viewerBlockedBy).toEqual(new Set(["carol"]));
    first.blockedByViewer.add("not-a-real-block");
    const second = await service.get("alice");
    expect(second.blockedByViewer).toEqual(new Set(["bob"]));
    expect(prisma.userBlock.findMany).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledWith(
      RedisKeys.viewerBlockSets("alice"),
      {
        blockedByViewer: ["bob"],
        viewerBlockedBy: ["carol"],
      },
      { ttlSeconds: 300 },
    );
  });

  it("invalidates both participants so a subsequent read reflects block and unblock", async () => {
    const { service, rows, cache } = fixture();
    await service.get("alice");
    cache.set(RedisKeys.viewerBlockSets("bob"), {
      blockedByViewer: [],
      viewerBlockedBy: ["alice"],
    });
    rows.splice(0, 1);
    await service.invalidate("alice", "bob");
    expect(cache.has(RedisKeys.viewerBlockSets("bob"))).toBe(false);
    expect((await service.get("alice")).blockedByViewer.size).toBe(0);
    rows.push({ blockerId: "alice", blockedId: "bob" });
    await service.invalidate("alice", "bob");
    expect((await service.get("alice")).blockedByViewer).toEqual(
      new Set(["bob"]),
    );
  });

  it("falls back to the database on corrupt cache data and cache read/write errors", async () => {
    const { service, cache, redis, prisma } = fixture();
    cache.set(RedisKeys.viewerBlockSets("alice"), {
      blockedByViewer: "invalid",
      viewerBlockedBy: [],
    });
    expect((await service.get("alice")).blockedByViewer).toEqual(
      new Set(["bob"]),
    );
    redis.getJson.mockRejectedValueOnce(new Error("redis unavailable"));
    redis.setJson.mockRejectedValueOnce(new Error("redis unavailable"));
    expect((await service.get("alice")).viewerBlockedBy).toEqual(
      new Set(["carol"]),
    );
    expect(prisma.userBlock.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not hide database failures or cache a false empty result", async () => {
    const { service, prisma, redis } = fixture();
    prisma.userBlock.findMany.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(service.get("alice")).rejects.toThrow("database unavailable");
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it("deduplicates invalidations and tolerates an unavailable cache after commit", async () => {
    const { service, redis } = fixture();
    redis.del.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(
      service.invalidate("alice", "bob", "alice", ""),
    ).resolves.toBeUndefined();
    expect(redis.del).toHaveBeenCalledWith(
      RedisKeys.viewerBlockSets("alice"),
      RedisKeys.viewerBlockSets("bob"),
    );
  });

  it("does no database or cache work for an anonymous viewer", async () => {
    const { service, prisma, redis } = fixture();
    expect(await service.get("")).toEqual({
      blockedByViewer: new Set(),
      viewerBlockedBy: new Set(),
    });
    expect(prisma.userBlock.findMany).not.toHaveBeenCalled();
    expect(redis.getJson).not.toHaveBeenCalled();
  });
});
