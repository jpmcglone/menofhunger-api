import { XPublishingService } from "./x-publishing.service";
import { xSourceHash } from "./x-publishing-plan";

import { PostsReadService } from '../posts-read/posts-read.service';
function fixture() {
  const source = {
    body: "Hello",
    media: [],
    poll: null,
    parentId: null,
    quotedPostId: null,
  };
  const row = {
    id: "delivery",
    userId: "user",
    resourceId: "post",
    connectionGeneration: "generation",
    version: 1,
  } as any;
  const copy: any = {
    id: "copy",
    remoteId: null,
    remoteIds: [],
    lastError: null,
    deliveryPlan: {
      parts: ["First", "Second"],
      sourceHash: xSourceHash(source),
      replyToId: null,
      quoteId: null,
      edit: false,
    },
  };
  const prisma: any = {
    post: { findFirst: jest.fn(async () => source), updateMany: jest.fn() },
    xCrosspost: {
      findUnique: jest.fn(async () => copy),
      update: jest.fn(async ({ data }) => {
        Object.assign(copy, data);
        return copy;
      }),
    },
    integrationSpendControl: {
      findUnique: jest.fn(async () => ({ paused: false })),
    },
    outboundDelivery: {
      findUnique: jest.fn(async () => ({
        version: 1,
        action: "create",
        status: "sending",
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const policy = {
    enabled: true,
    accountIds: ["123"],
    longAccountIds: [],
    quoteAccountIds: [],
    editAccountIds: ["123"],
    priceVersion: "fixture",
    postMaxMicros: 15000,
  };
  const config: any = {
    xPublishing: () => policy,
    integrationBudget: () => ({ enabled: true }),
  };
  const connections: any = {
    getActiveConnection: jest.fn(async () => ({
      xUserId: "123",
      generation: "generation",
    })),
    accessTokenFor: async () => "fixture-token",
  };
  const api: any = {
    createPost: jest
      .fn()
      .mockResolvedValueOnce("101")
      .mockResolvedValueOnce("102"),
  };
  const budgets: any = {
    reserve: jest.fn(async () => true),
    settle: jest.fn(),
  };
  const realtime: any = {
    emitPostsLiveUpdated: jest.fn(),
    emitPostsLiveUpdatedToUser: jest.fn(),
  };
  const service = new XPublishingService(prisma,
    config,
    connections,
    {} as any,
    api,
    budgets,
    {} as any,
    {} as any,
    realtime,
    { recordShared: jest.fn(), settle: jest.fn() } as any, new PostsReadService(prisma as never));
  return {
    service,
    source,
    row,
    copy,
    prisma,
    api,
    budgets,
    connections,
    realtime,
  };
}
describe("fixture X delivery outcomes", () => {
  it("persists each confirmed part, links the thread and settles once", async () => {
    const f = fixture();
    await f.service.send(f.row);
    expect(f.copy.remoteIds).toEqual(["101", "102"]);
    expect(f.api.createPost.mock.calls[1][1].replyToId).toBe("101");
    expect(f.budgets.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ publicationCount: 2, maximumMicros: 30000 }),
      expect.anything(),
    );
    expect(f.budgets.settle.mock.calls).toEqual([
      ["x:plan:delivery:1", "uncertain"],
      ["x:plan:delivery:1", "settled"],
    ]);
    expect(f.realtime.emitPostsLiveUpdated).toHaveBeenCalledTimes(1);
  });
  it("holds uncertain costs and never replays a partially confirmed thread", async () => {
    const f = fixture();
    f.api.createPost
      .mockReset()
      .mockResolvedValueOnce("101")
      .mockRejectedValueOnce(new Error("timeout"));
    await expect(f.service.send(f.row)).rejects.toThrow("needs review");
    expect(f.copy.remoteIds).toEqual(["101"]);
    expect(f.budgets.settle.mock.calls).toEqual([
      ["x:plan:delivery:1", "uncertain"],
    ]);
    await expect(f.service.send(f.row)).rejects.toThrow("existing X copy");
    expect(f.api.createPost).toHaveBeenCalledTimes(2);
  });
  it("releases unspent funds when paused before the first provider request", async () => {
    const f = fixture();
    f.prisma.integrationSpendControl.findUnique.mockResolvedValue({
      paused: true,
    });
    await expect(f.service.send(f.row)).rejects.toThrow(
      "spending controls changed",
    );
    expect(f.api.createPost).not.toHaveBeenCalled();
    expect(f.budgets.settle).toHaveBeenCalledWith(
      "x:plan:delivery:1",
      "released",
      0,
    );
  });
  it("stops when source changes after a confirmed part and preserves its identity", async () => {
    const f = fixture();
    f.api.createPost.mockReset().mockImplementation(async () => {
      f.source.body = "Edited elsewhere";
      return "101";
    });
    await expect(f.service.send(f.row)).rejects.toThrow("needs review");
    expect(f.api.createPost).toHaveBeenCalledTimes(1);
    expect(f.copy.remoteIds).toEqual(["101"]);
    expect(f.realtime.emitPostsLiveUpdated).not.toHaveBeenCalled();
  });
  it("does not dispatch with an expired or reclaimed lease", async () => {
    const f = fixture();
    f.prisma.outboundDelivery.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.send(f.row)).rejects.toThrow("lease expired");
    expect(f.api.createPost).not.toHaveBeenCalled();
  });
  it("cannot call X when the allowance reservation is refused", async () => {
    const f = fixture();
    f.budgets.reserve.mockResolvedValue(false);
    await expect(f.service.send(f.row)).rejects.toThrow("allowance");
    expect(f.api.createPost).not.toHaveBeenCalled();
  });
});
