import { AdminImageReviewService } from "./admin-image-review.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PublicProfileCacheService } from "../users/public-profile-cache.service";

describe("profile and publication media ownership", () => {
  const key = "announcements/notice.webp";
  const asset = {
    id: "asset",
    r2Key: key,
    createdAt: new Date(),
    deletedAt: null,
  };
  const setup = (assetKey = key) => {
    const indexedAsset = { ...asset, r2Key: assetKey };
    const prisma = {
      mediaAsset: {
        findUnique: jest.fn().mockResolvedValue(indexedAsset),
        findMany: jest.fn().mockResolvedValue([indexedAsset]),
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
      newsletter: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    const service = new AdminImageReviewService(
      prisma as unknown as PrismaService,
      { r2: () => null } as unknown as AppConfigService,
      { invalidateForUser: jest.fn() } as unknown as PublicProfileCacheService<{
        id: string;
        username: string | null;
      }>,
    );
    return { prisma, service };
  };


  it.each(['original.mp4', 'poster.jpg', 'audio.m4a'])(
    'protects channel originals and derivatives without producing public URLs (%s)', async file => {
      const channelKey = `channel-uploads/group/channel/member/${file}`;
      const { prisma, service } = setup(channelKey);
      expect((await service.getById('asset')).asset.primaryType).toBe('orphan');
      expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toHaveLength(1);
      prisma.messageMedia.findMany.mockResolvedValue([{
        id: 'media', messageId: 'message', r2Key: file === 'poster.jpg' ? 'other' : channelKey,
        thumbnailR2Key: file === 'poster.jpg' ? channelKey : null,
        message: {
          conversationId: 'conversation', createdAt: new Date('2026-10-06T18:00:00Z'), sender: { id: 'member', username: 'marcus', name: 'Marcus' },
          conversation: { groupChannel: { id: 'channel', name: 'general', displayName: null, privacy: 'private', groupId: 'group', group: { name: 'Iron Brothers', slug: 'iron-brothers' } } },
        },
      }]);
      const result = await service.getById('asset');
      expect(result.asset.primaryType).toBe(file === 'poster.jpg' ? 'message_thumbnail' : 'message');
      expect(result.asset.publicUrl).toBeNull();
      expect(result.references.messages[0]).toMatchObject({ channelId: 'channel', channelName: 'general', groupId: 'group', groupName: 'Iron Brothers', senderUsername: 'marcus' });
      expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toEqual([]);
      await expect(service.deleteById({ id: 'asset', adminUserId: 'admin', reason: 'cleanup', onlyOrphans: true }))
        .rejects.toThrow('no longer an orphan');
      expect((await service.deleteManyByIds({ ids: ['asset'], adminUserId: 'admin', reason: 'cleanup', onlyOrphans: true })).deleted).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['sourceKey', 'r2Key'])('retains unexpired channel upload %s and releases expired uploads', async field => {
    const channelKey = 'channel-uploads/group/channel/member/original.jpg';
    const { prisma, service } = setup(channelKey);
    prisma.groupChannelUpload.findMany.mockResolvedValue([{
      id: 'upload', channelId: 'channel', userId: 'member', sourceKey: 'other-source', r2Key: 'other-final',
      user: { username: 'marcus' }, channel: { name: 'general', displayName: null, groupId: 'group', group: { name: 'Iron Brothers', slug: 'iron-brothers' } },
      [field]: channelKey, expiresAt: new Date(Date.now() + 86_400_000),
    }]);
    expect((await service.getById('asset')).asset.primaryType).toBe('channel_upload');
    expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toEqual([]);
    await expect(service.deleteById({ id: 'asset', adminUserId: 'admin', reason: 'cleanup', onlyOrphans: true }))
      .rejects.toThrow('no longer an orphan');
    expect(prisma.groupChannelUpload.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ expiresAt: { gt: expect.any(Date) } }),
    }));
    prisma.groupChannelUpload.findMany.mockResolvedValue([]);
    expect((await service.getById('asset')).asset.primaryType).toBe('orphan');
  });

  it.each(["m4a", "wav"])(
    "protects sent voice messages and refuses stale orphan deletion (%s)",
    async (extension) => {
      const voiceKey = `chat/user/voice.${extension}`;
      const { prisma, service } = setup(voiceKey);
      expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
      expect(
        (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
          .items,
      ).toHaveLength(1);
      prisma.messageMedia.findMany.mockResolvedValue([
        {
          id: "voice",
          messageId: "message",
          r2Key: voiceKey,
          thumbnailR2Key: null,
          message: { conversationId: "chat", createdAt: new Date("2026-10-06T18:00:00Z"), sender: { id: "member", username: "marcus", name: "Marcus" }, conversation: null },
        },
      ]);
      expect((await service.getById("asset")).asset.primaryType).toBe(
        "message",
      );
      expect(
        (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
          .items,
      ).toEqual([]);
      await expect(
        service.deleteById({
          id: "asset",
          adminUserId: "admin",
          reason: "cleanup",
          onlyOrphans: true,
        }),
      ).rejects.toThrow("no longer an orphan");
      expect(
        (
          await service.deleteManyByIds({
            ids: ["asset"],
            adminUserId: "admin",
            reason: "cleanup",
            onlyOrphans: true,
          })
        ).deleted,
      ).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("protects Board thread images (post media) and refuses stale orphan deletion", async () => {
    const boardImageKey = "uploads/user/images/board-thread.webp";
    const { prisma, service } = setup(boardImageKey);
    expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
    expect(
      (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
        .items,
    ).toHaveLength(1);
    prisma.postMedia.findMany.mockResolvedValue([
      {
        id: "media",
        postId: "board-thread",
        r2Key: boardImageKey,
        thumbnailR2Key: null,
        deletedAt: null,
        post: {
          id: "board-thread",
          createdAt: new Date(),
          visibility: "premiumOnly",
          user: { id: "user", username: "john" },
        },
      },
    ]);
    expect((await service.getById("asset")).asset.primaryType).toBe("post");
    expect(
      (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
        .items,
    ).toEqual([]);
    await expect(
      service.deleteById({
        id: "asset",
        adminUserId: "admin",
        reason: "cleanup",
        onlyOrphans: true,
      }),
    ).rejects.toThrow("no longer an orphan");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("account erasure rechecks ownership and only deletes unreferenced media", async () => {
    const { prisma, service } = setup("avatars/user/photo.webp");
    const send = jest.fn(async () => ({}));
    jest
      .spyOn(service as any, "requireR2")
      .mockReturnValue({ s3: { send }, bucket: "synthetic" });
    (prisma as any).mediaContentHash = {
      deleteMany: jest.fn(async () => ({ count: 1 })),
    };
    (prisma.mediaAsset as any).deleteMany = jest.fn(async () => ({ count: 1 }));
    prisma.user.findMany.mockResolvedValue([
      {
        id: "other",
        username: "other",
        name: "Other",
        avatarKey: "avatars/user/photo.webp",
        avatarVideoKey: null,
        bannerKey: null,
      },
    ]);
    await service.eraseUnreferencedAccountMedia(["avatars/user/photo.webp"]);
    expect(send).not.toHaveBeenCalled();
    prisma.user.findMany.mockResolvedValue([]);
    await service.eraseUnreferencedAccountMedia(["avatars/user/photo.webp"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((prisma.mediaAsset as any).deleteMany).toHaveBeenCalledWith({
      where: { r2Key: "avatars/user/photo.webp" },
    });
  });

  it("leaves external deletion failures retryable instead of dropping the ownership index", async () => {
    const { prisma, service } = setup();
    jest.spyOn(service as any, "requireR2").mockReturnValue({
      s3: {
        send: jest.fn(async () => {
          throw new Error("synthetic offline");
        }),
      },
      bucket: "synthetic",
    });
    (prisma.mediaAsset as any).deleteMany = jest.fn();
    await expect(service.eraseUnreferencedAccountMedia([key])).rejects.toThrow(
      "synthetic offline",
    );
    expect((prisma.mediaAsset as any).deleteMany).not.toHaveBeenCalled();
  });

  const avatarVideoKey = "avatars/user/video/version/avatar.mp4";
  const avatarPosterKey = "avatars/user/video/version/poster.jpg";
  const avatarUser = {
    id: "user",
    username: "john",
    name: "John",
    premium: false,
    premiumPlus: false,
    verifiedStatus: "none",
    avatarKey: avatarPosterKey,
    avatarVideoKey,
    bannerKey: null,
  };

  it.each([
    ["photo", "avatars/user/photo.webp"],
    ["video", avatarVideoKey],
    ["poster", avatarPosterKey],
  ])(
    "keeps a current profile %s out of orphans without an upload record or paid tier",
    async (kind, assetKey) => {
      const { prisma, service } = setup(assetKey);
      prisma.user.findMany.mockResolvedValue([
        {
          ...avatarUser,
          ...(kind === "photo"
            ? { avatarKey: assetKey, avatarVideoKey: null }
            : {}),
        },
      ]);
      // Upload bookkeeping can expire; the current profile remains the authoritative owner.
      const detail = await service.getById("asset");
      expect(detail.asset.primaryType).toBe("user");
      expect(detail.references.users).toEqual([
        expect.objectContaining({ id: "user", isAvatar: true }),
      ]);
      const list = await service.list({
        limit: 30,
        cursor: null,
        onlyOrphans: true,
      });
      expect(list.items).toEqual([]);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { avatarKey: { in: [assetKey] } },
              { avatarVideoKey: { in: [assetKey] } },
              { bannerKey: { in: [assetKey] } },
            ],
          },
        }),
      );
    },
  );

  it.each(
    ["queued", "processing"].flatMap((status) =>
      ["sourceKey", "videoKey", "posterKey"].map((field) => [status, field]),
    ),
  )("protects %s avatar job media referenced by %s", async (status, field) => {
    const keys: Record<string, string> = {
      sourceKey: "avatars/user/video/version/source.mov",
      videoKey: avatarVideoKey,
      posterKey: avatarPosterKey,
    };
    const { prisma, service } = setup(keys[field]);
    prisma.avatarVideoUpload.findMany.mockResolvedValue([
      { ...keys, id: "job", userId: "user", user: avatarUser, status },
    ]);
    expect((await service.getById("asset")).asset.primaryType).toBe("user");
    expect(
      (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
        .items,
    ).toEqual([]);
  });

  it.each([avatarVideoKey, avatarPosterKey])(
    "rejects stale single and bulk orphan deletion after a profile adopts %s",
    async (assetKey) => {
      const { prisma, service } = setup(assetKey);
      expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
      prisma.user.findMany.mockResolvedValue([avatarUser]);
      await expect(
        service.deleteById({
          id: "asset",
          adminUserId: "admin",
          reason: "Orphan cleanup",
          onlyOrphans: true,
        }),
      ).rejects.toThrow("no longer an orphan");
      const bulk = await service.deleteManyByIds({
        ids: ["asset"],
        adminUserId: "admin",
        reason: "Orphan cleanup",
        onlyOrphans: true,
      });
      expect(bulk.deleted).toBe(0);
      expect(bulk.errors).toHaveLength(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("classifies an unreferenced old avatar as an orphan instead of exempting the whole avatar prefix", async () => {
    const { service } = setup("avatars/user/video/replaced/avatar.mp4");
    expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
    const list = await service.list({
      limit: 30,
      cursor: null,
      onlyOrphans: true,
    });
    expect(list.items).toEqual([
      expect.objectContaining({ id: "asset", belongsToSummary: "orphan" }),
    ]);
  });

  it("protects canonical media used by delegated drafts and scheduled publications", async () => {
    const { prisma, service } = setup("posts/page/photo.webp");
    expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
    prisma.postMedia.findMany.mockResolvedValue([
      {
        id: "media",
        postId: "draft",
        r2Key: "posts/page/photo.webp",
        thumbnailR2Key: null,
        deletedAt: null,
        post: {
          id: "draft",
          createdAt: new Date(),
          visibility: "onlyMe",
          user: { id: "page", username: "mohnews" },
        },
      },
    ]);
    expect((await service.getById("asset")).asset.primaryType).toBe("post");
    expect(
      (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
        .items,
    ).toEqual([]);
    await expect(
      service.deleteById({
        id: "asset",
        adminUserId: "admin",
        reason: "cleanup",
        onlyOrphans: true,
      }),
    ).rejects.toThrow("no longer an orphan");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["draft", "published", "archived"])(
    "recognizes %s announcement images and excludes them from orphans",
    async (status) => {
      const { prisma, service } = setup();
      prisma.announcement.findMany.mockResolvedValue([
        { id: "notice", title: "Conference", status, imageKey: key },
      ]);
      const detail = await service.getById("asset");
      expect(detail.asset.primaryType).toBe("announcement");
      expect(detail.references.announcements).toEqual([
        { id: "notice", title: "Conference", status, isInline: false },
      ]);
      const list = await service.list({
        limit: 30,
        cursor: null,
        onlyOrphans: true,
      });
      expect(list.items).toEqual([]);
      expect(prisma.announcement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { imageKey: { in: [key] } } }),
      );
    },
  );

  it.each(["draft", "published", "unpublished"])(
    "protects %s native Article source images after a remote draft is retained",
    async (state) => {
      const articleKey = "article-media/user/source.webp";
      const { prisma, service } = setup(articleKey);
      expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
      prisma.article.findMany.mockResolvedValue([
        {
          id: "article",
          slug: "source",
          title: "Source",
          authorId: "user",
          thumbnailR2Key: null,
          isDraft: state === "draft",
          publishedAt: state === "published" ? new Date() : null,
          body: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "image",
                attrs: { src: `https://cdn.example/${articleKey}` },
              },
            ],
          }),
        },
      ]);
      expect((await service.getById("asset")).asset.primaryType).toBe(
        "article_inline",
      );
      expect(
        (await service.list({ limit: 30, cursor: null, onlyOrphans: true }))
          .items,
      ).toEqual([]);
      await expect(
        service.deleteById({
          id: "asset",
          adminUserId: "admin",
          reason: "cleanup",
          onlyOrphans: true,
        }),
      ).rejects.toThrow("no longer an orphan");
      expect(
        (
          await service.deleteManyByIds({
            ids: ["asset"],
            adminUserId: "admin",
            reason: "cleanup",
            onlyOrphans: true,
          })
        ).deleted,
      ).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["draft", "scheduled", "sent"])(
    "protects %s newsletter cover and body images",
    async (status) => {
      const { prisma, service } = setup();
      prisma.newsletter.findMany.mockResolvedValue([
        { id: "cover", subject: "Cover", status, imageKey: key, bodyJson: "" },
        {
          id: "inline",
          subject: "Inline",
          status,
          imageKey: null,
          bodyJson: JSON.stringify({
            type: "image",
            attrs: { src: `https://cdn.example/${key}` },
          }),
        },
      ]);
      const detail = await service.getById("asset");
      expect(detail.asset.primaryType).toBe("newsletter");
      expect(
        detail.references.newsletters.map((ref) => [ref.id, ref.isInline]),
      ).toEqual([
        ["cover", false],
        ["inline", true],
      ]);
    },
  );

  it("rechecks ownership before deleting a stale orphan selection, including bulk deletion", async () => {
    const { prisma, service } = setup();
    expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
    prisma.announcement.findMany.mockResolvedValue([
      { id: "notice", title: "New notice", status: "draft", imageKey: key },
    ]);
    await expect(
      service.deleteById({
        id: "asset",
        adminUserId: "admin",
        reason: "Orphan cleanup",
      }),
    ).rejects.toThrow("still used");
    const bulk = await service.deleteManyByIds({
      ids: ["asset"],
      adminUserId: "admin",
      reason: "Orphan cleanup",
    });
    expect(bulk.deleted).toBe(0);
    expect(bulk.errors).toHaveLength(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects an orphan-only delete when a profile starts using the asset", async () => {
    const { prisma, service } = setup();
    prisma.user.findMany.mockResolvedValue([
      { id: "user", username: "john", avatarKey: key, bannerKey: null },
    ]);
    await expect(
      service.deleteById({
        id: "asset",
        adminUserId: "admin",
        reason: "Orphan cleanup",
        onlyOrphans: true,
      }),
    ).rejects.toThrow("no longer an orphan");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { surface: "profile avatar", assetKey: "avatars/user/photo.webp", owner: "user", field: "avatarKey", primaryType: "user" },
    { surface: "profile banner", assetKey: "covers/user/banner.webp", owner: "user", field: "bannerKey", primaryType: "user" },
    { surface: "group avatar", assetKey: "uploads/user/group-images/avatar.webp", owner: "communityGroup", field: "avatarImageUrl", primaryType: "group" },
    { surface: "group cover", assetKey: "uploads/user/group-images/cover.webp", owner: "communityGroup", field: "coverImageUrl", primaryType: "group" },
    { surface: "crew avatar", assetKey: "uploads/user/crew-images/avatar.webp", owner: "crew", field: "avatarImageUrl", primaryType: "crew" },
    { surface: "crew cover", assetKey: "uploads/user/crew-images/cover.webp", owner: "crew", field: "coverImageUrl", primaryType: "crew" },
  ] as const)(
    "protects the shared banner/avatar editor's $surface and releases it once unreferenced",
    async ({ assetKey, owner, field, primaryType }) => {
      const { prisma, service } = setup(assetKey);
      const row =
        owner === "user"
          ? { id: "user", username: "john", avatarKey: null, avatarVideoKey: null, bannerKey: null, [field]: assetKey }
          : { id: owner, slug: owner, name: "Iron Brothers", avatarImageUrl: null, coverImageUrl: null, [field]: assetKey };
      prisma[owner].findMany.mockResolvedValue([row]);

      expect((await service.getById("asset")).asset.primaryType).toBe(primaryType);
      expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toEqual([]);
      await expect(
        service.deleteById({ id: "asset", adminUserId: "admin", reason: "cleanup", onlyOrphans: true }),
      ).rejects.toThrow("no longer an orphan");
      expect(
        (await service.deleteManyByIds({ ids: ["asset"], adminUserId: "admin", reason: "cleanup", onlyOrphans: true })).deleted,
      ).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();

      prisma[owner].findMany.mockResolvedValue([]);
      expect((await service.getById("asset")).asset.primaryType).toBe("orphan");
      expect((await service.list({ limit: 30, cursor: null, onlyOrphans: true })).items).toHaveLength(1);
    },
  );

  it("finds legacy CDN references even in batches larger than forty assets", async () => {
    const { prisma, service } = setup();
    prisma.mediaAsset.findMany.mockResolvedValue(
      Array.from({ length: 45 }, (_, i) => ({
        ...asset,
        id: `asset-${i}`,
        r2Key: `group-images/photo-${i}.webp`,
      })),
    );
    const legacyGroup = {
      id: "group",
      slug: "group",
      name: "Group",
      avatarImageUrl:
        "https://old-cdn.example/group-images/photo-44.webp?v=old",
      coverImageUrl: null,
    };
    prisma.communityGroup.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([legacyGroup]);
    const result = await service.list({
      limit: 50,
      cursor: null,
      onlyOrphans: true,
    });
    expect(result.items).toHaveLength(44);
    expect(result.items.some((item) => item.id === "asset-44")).toBe(false);
  });
});
