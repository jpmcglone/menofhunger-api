import { XCrosspostService } from "./x-crosspost.service";
import { X_REFERENCE_PRICES } from "./integration-budget.policy";

import { PostsReadService } from '../posts-read/posts-read.service';
import { PostsWriteService } from '../posts-read/posts-write.service';
describe("durable X Article publishing", () => {
  function harness() {
    const source = {
      id: "article",
      authorId: "member",
      title: "Title",
      body: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Body" }] },
        ],
      }),
      thumbnailR2Key: null,
      deletedAt: null,
      isDraft: false,
      publishedAt: new Date(),
      visibility: "public",
    };
    const row: any = {
      id: "copy",
      userId: "member",
      remoteId: null,
      draftId: null,
      refundedAt: null,
      mode: "native",
    };
    const prisma = {
      article: {
        findUnique: jest.fn(async () => source),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      xCrosspost: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }) => Object.assign(row, data)),
        updateMany: jest.fn(async ({ data }) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const policy = { enabled: true, priceVersion: X_REFERENCE_PRICES.version };
    const config = {
      xArticle: () => ({
        enabled: true,
        accountIds: ["123"],
        maximumMicros: 25_000,
        priceVersion: "confirmed-article-test",
        bucket: "regular",
      }),
      integrationBudget: () => policy,
      r2: () => null,
    };
    const api = {
      createArticleDraft: jest.fn(async () => "draft-id"),
      publishArticle: jest.fn(async () => "post-id"),
      uploadImage: jest.fn(),
    };
    const budgets = {
      reserve: jest.fn(async () => true),
      settle: jest.fn(async () => undefined),
    };
    const realtime = {
      emitArticlesLiveUpdated: jest.fn(),
      emitArticlesLiveUpdatedToUser: jest.fn(),
    };
    const connections = {
      getActiveConnection: async () => ({
        xUserId: "123",
        generation: "generation",
      }),
      accessTokenFor: async () => "token",
    };
    const service = new XCrosspostService(prisma as any,
      {} as any,
      { settle: jest.fn(), recordShared: jest.fn() } as any,
      config as any,
      connections as any,
      api as any,
      realtime as any,
      budgets as any, new PostsReadService(prisma as any as never), new PostsWriteService(prisma as any as never));
    return { service, row, source, api, budgets, policy, prisma };
  }
  it("persists the draft before the publish request and settles one publication", async () => {
    const h = harness();
    h.api.publishArticle.mockImplementation(async () => {
      expect(h.row.draftId).toBe("draft-id");
      expect(h.row.draftSourceHash).toMatch(/^[a-f0-9]{64}$/);
      return "post-id";
    });
    await h.service.syncArticle("article", "generation");
    expect(h.row.remoteId).toBe("post-id");
    expect(h.budgets.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationCount: 1,
        maximumMicros: 25_000,
        bucket: "regular",
      }),
      expect.anything(),
    );
    expect(h.budgets.settle).toHaveBeenLastCalledWith(
      "x:article:article",
      "settled",
    );
  });
  it("retains the draft and cost hold after a publish timeout without creating again", async () => {
    const h = harness();
    h.api.publishArticle.mockRejectedValue(new Error("timeout"));
    await h.service.syncArticle("article", "generation");
    await h.service.syncArticle("article", "generation");
    expect(h.row.draftId).toBe("draft-id");
    expect(h.row.remoteId).toBeNull();
    expect(h.api.createArticleDraft).toHaveBeenCalledTimes(1);
    expect(h.api.publishArticle).toHaveBeenCalledTimes(1);
    expect(h.budgets.settle).not.toHaveBeenCalledWith(
      "x:article:article",
      "released",
      expect.anything(),
    );
  });
  it("rechecks visibility after draft creation", async () => {
    const h = harness();
    h.api.createArticleDraft.mockImplementation(async () => {
      h.source.visibility = "verifiedOnly";
      return "draft-id";
    });
    await h.service.syncArticle("article", "generation");
    expect(h.row.draftId).toBe("draft-id");
    expect(h.api.publishArticle).not.toHaveBeenCalled();
  });
  it("does not send when the budget is unavailable", async () => {
    const h = harness();
    h.budgets.reserve.mockResolvedValue(false);
    await h.service.syncArticle("article", "generation");
    expect(h.api.createArticleDraft).not.toHaveBeenCalled();
  });
});
