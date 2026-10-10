import { AdminImageReviewActionsService } from "./admin-image-review-actions.service";

describe("admin message media deletion", () => {
  it.each([false, true])(
    "retains stable attachment rows, revokes upload grants and publishes filtered snapshots (channel=%s)",
    async (channel) => {
      const key = "uploads/member/images/photo.jpg";
      const delegates = new Map<string, any>();
      const tx: any = new Proxy(
        {},
        {
          get: (_target, name: string) => {
            if (!delegates.has(name))
              delegates.set(name, {
                findMany: jest.fn().mockResolvedValue([]),
                updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
                update: jest.fn(),
              });
            return delegates.get(name);
          },
        },
      );
      tx.messageMedia.findMany.mockResolvedValue([
        {
          r2Key: key,
          thumbnailR2Key: null,
          messageId: "message",
          message: {
            conversation: {
              groupChannel: channel
                ? { id: "channel", groupId: "group" }
                : null,
            },
          },
        },
      ]);
      const prisma: any = {
        $transaction: jest.fn(async (fn) => fn(tx)),
        mediaAsset: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: "asset", r2Key: key, deletedAt: null }),
          update: jest.fn(),
        },
      };
      const storage: any = {
        publicUrlForKey: () => null,
        requireR2: () => ({ s3: { send: jest.fn() } }),
        bucketForKey: () => "bucket",
      };
      const refs: any = {
        resolvePublicationReferences: jest
          .fn()
          .mockResolvedValue(
            new Map([
              [
                key,
                { announcements: [], newsletters: [], emailDeliveries: [] },
              ],
            ]),
          ),
      };
      const realtime: any = { rebroadcastMessage: jest.fn() };
      const channels: any = { publishMediaChange: jest.fn() };
      const service = new AdminImageReviewActionsService(
        storage,
        refs,
        {} as any,
        prisma,
        { invalidateForUser: jest.fn() } as any,
        realtime,
        channels,
      );
      await expect(
        service.deleteById({
          id: "asset",
          adminUserId: "admin",
          reason: "review",
        }),
      ).resolves.toMatchObject({
        success: true,
        messageMediaCount: 1,
        r2Deleted: true,
      });
      expect(tx.messageMedia.deleteMany).not.toHaveBeenCalled();
      expect(tx.messageMedia.updateMany).not.toHaveBeenCalled();
      expect(tx.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(tx.mediaUploadGrant.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ r2Key: key }, { thumbnailR2Key: key }] },
      });
      if (channel)
        expect(channels.publishMediaChange).toHaveBeenCalledWith(
          "group",
          "channel",
          "message",
        );
      else expect(realtime.rebroadcastMessage).toHaveBeenCalledWith("message");
    },
  );
});
