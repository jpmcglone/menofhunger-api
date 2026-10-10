import type { AppConfigService } from "../app/app-config.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { PublicProfileCacheService } from "../users/public-profile-cache.service";
import { makeAdminImageReviewService } from "./admin-image-review.testing";

type Surface = "post" | "message";

function fixture(surface: Surface) {
  const createdAt = new Date("2026-10-10T12:00:00Z");
  // These are the existing init/commit paths used by iOS file-backed background PUTs.
  const videoKey = `dev/uploads/member/videos/${surface}.mp4`;
  const thumbnailKey = `dev/uploads/member/thumbnails/${surface}.jpg`;
  const orphanKey = `dev/uploads/member/videos/unreferenced-${surface}.mp4`;
  const assets = [videoKey, thumbnailKey, orphanKey].map((r2Key, index) => ({
    id: ["video", "thumbnail", "orphan"][index],
    r2Key,
    createdAt,
    deletedAt: null,
    kind: index === 1 ? "image" : "video",
    contentType: index === 1 ? "image/jpeg" : "video/mp4",
  }));
  const prisma = {
    mediaAsset: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        assets.find((asset) => asset.id === where.id),
      ),
      findMany: jest.fn().mockResolvedValue(assets),
    },
    mediaUploadGrant: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    postMedia: { findMany: jest.fn().mockResolvedValue([]) },
    messageMedia: { findMany: jest.fn().mockResolvedValue([]) },
    groupChannelUpload: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    communityGroup: { findMany: jest.fn().mockResolvedValue([]) },
    crew: { findMany: jest.fn().mockResolvedValue([]) },
    postPollOption: { findMany: jest.fn().mockResolvedValue([]) },
    article: { findMany: jest.fn().mockResolvedValue([]) },
    announcement: { findMany: jest.fn().mockResolvedValue([]) },
    avatarVideoUpload: { findMany: jest.fn().mockResolvedValue([]) },
    emailDelivery: { findMany: jest.fn().mockResolvedValue([]) },
    newsletter: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  const service = makeAdminImageReviewService(
    prisma as unknown as PrismaService,
    { r2: () => null } as unknown as AppConfigService,
    { invalidateForUser: jest.fn() } as unknown as PublicProfileCacheService<{
      id: string;
      username: string | null;
    }>,
  );
  const adoptVideo = () => {
    const media = {
      id: `${surface}-media`,
      source: "upload",
      kind: "video",
      r2Key: videoKey,
      thumbnailR2Key: thumbnailKey,
    };
    if (surface === "post") {
      prisma.postMedia.findMany.mockResolvedValue([
        {
          ...media,
          postId: "post",
          deletedAt: null,
          post: {
            createdAt,
            visibility: "onlyMe",
            user: { id: "member", username: "marcus" },
          },
        },
      ]);
    } else {
      prisma.messageMedia.findMany.mockResolvedValue([
        {
          ...media,
          messageId: "message",
          message: {
            conversationId: "dm",
            createdAt,
            sender: { id: "member", username: "marcus", name: "Marcus" },
            conversation: { groupChannel: null },
          },
        },
      ]);
    }
  };
  return { prisma, service, adoptVideo, videoKey, thumbnailKey, orphanKey };
}

describe.each<Surface>(["post", "message"])(
  "background-uploaded %s video ownership",
  (surface) => {
    it("protects the committed video and poster while keeping unused uploads discoverable", async () => {
      const { service, adoptVideo, videoKey, thumbnailKey, orphanKey } =
        fixture(surface);
      adoptVideo();

      const references = await service.resolveAllReferences([
        videoKey,
        thumbnailKey,
        orphanKey,
      ]);
      expect(references.get(videoKey)?.primaryType).toBe(surface);
      expect(references.get(thumbnailKey)?.primaryType).toBe(
        `${surface}_thumbnail`,
      );
      expect(references.get(orphanKey)?.primaryType).toBe("orphan");

      const video = await service.getById("video");
      const poster = await service.getById("thumbnail");
      const ownerReferences = surface === "post" ? "posts" : "messages";
      expect(video.references[ownerReferences]).toEqual([
        expect.objectContaining({ isThumbnail: false }),
      ]);
      expect(poster.references[ownerReferences]).toEqual([
        expect.objectContaining({ isThumbnail: true }),
      ]);
      if (surface === "post") {
        expect(video.references.posts[0]).toMatchObject({
          postId: "post",
          postVisibility: "onlyMe",
          author: { id: "member" },
        });
      } else {
        expect(video.references.messages[0]).toMatchObject({
          messageId: "message",
          conversationId: "dm",
          senderId: "member",
        });
      }

      const orphans = await service.list({
        limit: 30,
        cursor: null,
        onlyOrphans: true,
      });
      expect(orphans.items).toEqual([
        expect.objectContaining({
          id: "orphan",
          r2Key: orphanKey,
          belongsToSummary: "orphan",
        }),
      ]);
    });

    it.each(["video", "thumbnail"])(
      "refuses stale single and bulk orphan deletion after a %s acquires an owner",
      async (id) => {
        const { prisma, service, adoptVideo } = fixture(surface);
        const staleList = await service.list({
          limit: 30,
          cursor: null,
          onlyOrphans: true,
        });
        expect(staleList.items.map((asset) => asset.id)).toContain(id);
        expect((await service.getById(id)).asset.primaryType).toBe("orphan");

        adoptVideo();

        await expect(
          service.deleteById({
            id,
            adminUserId: "admin",
            reason: "Orphan cleanup",
            onlyOrphans: true,
          }),
        ).rejects.toThrow("no longer an orphan");
        const bulk = await service.deleteManyByIds({
          ids: [id],
          adminUserId: "admin",
          reason: "Orphan cleanup",
          onlyOrphans: true,
        });
        expect(bulk).toEqual({
          deleted: 0,
          skipped: 0,
          errors: [
            { id, message: expect.stringContaining("no longer an orphan") },
          ],
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  },
);
