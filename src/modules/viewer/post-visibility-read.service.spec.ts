import { PostVisibilityReadService } from "./post-visibility-read.service";
import { PostsReadService } from "../posts-read/posts-read.service";
import { ViewerBlockSetsService } from "./viewer-block-sets.service";
import { PostsViewerEnrichmentService } from "../posts/posts-viewer-enrichment.service";

function fixture(siteAdmin = false) {
  const prisma: any = {
    post: { findMany: jest.fn(async () => []) },
    userBlock: {
      findMany: jest.fn(async () => [{ blockerId: "alice", blockedId: "bob" }]),
    },
  };
  const cache = new Map<string, unknown>();
  const redis: any = {
    getJson: async (key: string) => cache.get(key),
    setJson: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
  };
  const blocks = new ViewerBlockSetsService(prisma, redis);
  const viewer: any = {
    getViewer: async () => ({ id: "alice", siteAdmin }),
    allowedPostVisibilities: () => ["public"],
  };
  const service = new PostVisibilityReadService(
    prisma,
    new PostsReadService(prisma),
    {} as any,
    viewer,
    blocks,
  );
  return { service, prisma, blocks, viewer };
}

describe("Viewer-scoped post reads", () => {
  it("preserves requested order and self access while filtering inaccessible tiers and private posts", async () => {
    const { service, prisma } = fixture();
    prisma.post.findMany.mockResolvedValue([
      { id: "public", userId: "bob", visibility: "public" },
      { id: "private", userId: "bob", visibility: "onlyMe" },
      { id: "premium", userId: "bob", visibility: "premiumOnly" },
      { id: "mine", userId: "alice", visibility: "onlyMe" },
    ]);
    const rows = await service.getVisiblePostsByIds({
      viewerUserId: "alice",
      ids: ["mine", "private", "premium", "public", "mine"],
    });
    expect(rows.map((row) => row.id)).toEqual(["mine", "public"]);
    expect(prisma.post.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it("retains explicitly requested tombstones without dropping viewer access checks", async () => {
    const { service, prisma } = fixture();
    prisma.post.findMany.mockResolvedValue([
      {
        id: "removed",
        userId: "bob",
        visibility: "public",
        deletedAt: new Date(),
      },
      {
        id: "private",
        userId: "bob",
        visibility: "onlyMe",
        deletedAt: new Date(),
      },
    ]);
    const rows = await service.getVisiblePostsByIds({
      viewerUserId: "alice",
      ids: ["removed", "private"],
      includeDeleted: true,
    });
    expect(rows.map((row) => row.id)).toEqual(["removed"]);
    expect(prisma.post.findMany.mock.calls[0][0].where).not.toHaveProperty(
      "deletedAt",
    );
  });

  it("preserves the existing admin exception for onlyMe rows", async () => {
    const { service, prisma } = fixture(true);
    prisma.post.findMany.mockResolvedValue([
      { id: "private", userId: "bob", visibility: "onlyMe" },
    ]);
    expect(
      (
        await service.getVisiblePostsByIds({
          viewerUserId: "alice",
          ids: ["private"],
        })
      ).map((row) => row.id),
    ).toEqual(["private"]);
  });

  it("feed enrichment and embedded-post visibility share one block projection", async () => {
    const { service, prisma, blocks, viewer } = fixture();
    const enrichment = new PostsViewerEnrichmentService(
      prisma,
      {} as any,
      viewer,
      blocks,
    );
    expect((await service.viewerBlockSets("alice")).blockedByViewer).toEqual(
      new Set(["bob"]),
    );
    expect((await enrichment.viewerBlockSets("alice")).blockedByViewer).toEqual(
      new Set(["bob"]),
    );
    expect(prisma.userBlock.findMany).toHaveBeenCalledTimes(1);
  });
});
