import { MessagesConversationStateService } from "./messages-conversation-state.service";
import { ViewerBlockSetsService } from "../viewer/viewer-block-sets.service";

function fixture() {
  const order: string[] = [];
  const prisma: any = {
    userBlock: {
      upsert: jest.fn(async () => {
        order.push("block");
      }),
      deleteMany: jest.fn(async () => {
        order.push("unblock");
      }),
    },
    follow: {
      deleteMany: jest.fn(async () => {
        order.push("unfollow");
      }),
    },
  };
  prisma.$transaction = jest.fn(async (run: (tx: any) => Promise<void>) => {
    await run(prisma);
    order.push("commit");
  });
  const redis: any = {
    del: jest.fn(async () => {
      order.push("invalidate");
    }),
  };
  const blockSets = new ViewerBlockSetsService(prisma, redis);
  const realtime: any = {
    emitUsersMeRefresh: jest.fn(() => {
      order.push("refresh");
    }),
  };
  const support: any = { emitUnreadCounts: jest.fn() };
  const service = new MessagesConversationStateService(
    prisma,
    {} as any,
    realtime,
    {} as any,
    redis,
    support,
    blockSets,
  );
  return { service, prisma, redis, realtime, order };
}

describe("Block policy completion", () => {
  it("commits block and unfollow before invalidating both sides and publishing refresh", async () => {
    const { service, prisma, redis, order } = fixture();
    await service.blockUser({ userId: "alice", targetUserId: "bob" });
    expect(order).toEqual([
      "block",
      "unfollow",
      "commit",
      "invalidate",
      "refresh",
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(
      "viewer:blocks:alice",
      "viewer:blocks:bob",
    );
  });

  it("does not invalidate or publish a successful block when its transaction fails", async () => {
    const { service, prisma, redis, realtime } = fixture();
    prisma.follow.deleteMany.mockRejectedValueOnce(
      new Error("transaction failed"),
    );
    await expect(
      service.blockUser({ userId: "alice", targetUserId: "bob" }),
    ).rejects.toThrow("transaction failed");
    expect(redis.del).not.toHaveBeenCalled();
    expect(realtime.emitUsersMeRefresh).not.toHaveBeenCalled();
  });

  it("finishes invalidation before a cross-device unblock refresh can fetch old cache", async () => {
    const { service, redis, realtime, order } = fixture();
    let finish!: () => void;
    redis.del.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.unblockUser({
      userId: "alice",
      targetUserId: "bob",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(realtime.emitUsersMeRefresh).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(order).toEqual(["unblock", "refresh"]);
  });

  it("does not access storage or emit when a viewer tries to block himself", async () => {
    const { service, prisma, realtime } = fixture();
    await expect(
      service.blockUser({ userId: "alice", targetUserId: "alice" }),
    ).rejects.toThrow("cannot block yourself");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(realtime.emitUsersMeRefresh).not.toHaveBeenCalled();
  });
});
