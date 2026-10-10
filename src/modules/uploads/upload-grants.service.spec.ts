import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { UploadGrantsService } from "./upload-grants.service";

jest.mock("image-size", () => ({
  imageSize: jest.fn(() => ({ width: 320, height: 240, type: "jpg" })),
}));

function setup() {
  const grant = {
    userId: "sender",
    r2Key: "dev/uploads/owner/images/photo.jpg",
    committedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400_000),
    kind: "image",
    contentType: "image/jpeg",
    bytes: 100,
    etag: '"etag"',
    width: 320,
    height: 240,
    durationSeconds: null,
    thumbnailR2Key: null,
  };
  const prisma: any = {
    mediaUploadGrant: {
      findUnique: jest.fn().mockResolvedValue(grant),
      upsert: jest.fn(async (args) => args.create),
    },
    mediaContentHash: { findUnique: jest.fn().mockResolvedValue(null) },
    mediaAsset: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const send = jest.fn(async (command): Promise<Record<string, unknown>> => {
    if (command instanceof CopyObjectCommand)
      return { CopyObjectResult: { ETag: grant.etag } };
    if (command instanceof GetObjectCommand)
      return {
        Body: (async function* () {
          yield Buffer.from("image");
        })(),
      };
    return {
      ETag: grant.etag,
      ContentLength: grant.bytes,
      ContentType: grant.contentType,
    };
  });
  const storage: any = {
    requireR2: () => ({ s3: { send }, bucket: "bucket" }),
    objectKeyPrefix: () => "dev/",
    getImageInfoAndNormalizeJpegIfNeeded: jest
      .fn()
      .mockResolvedValue({ width: 100, height: 80 }),
  };
  return {
    grant,
    prisma,
    send,
    storage,
    service: new UploadGrantsService(prisma, storage),
  };
}

describe("durable upload authorization", () => {
  it("requires the acting user’s committed grant and returns canonical dimensions", async () => {
    const h = setup();
    await expect(
      h.service.photo("sender", {
        source: "upload",
        kind: "image",
        r2Key: h.grant.r2Key,
        width: 999,
      }),
    ).resolves.toMatchObject({ width: 320, height: 240 });
    expect(h.prisma.mediaUploadGrant.findUnique).toHaveBeenCalledWith({
      where: { userId_r2Key: { userId: "sender", r2Key: h.grant.r2Key } },
    });
    h.prisma.mediaUploadGrant.findUnique.mockResolvedValue(null);
    await expect(
      h.service.photo("other", {
        source: "upload",
        kind: "image",
        r2Key: h.grant.r2Key,
      }),
    ).rejects.toThrow("Attach the file again");
  });

  it.each([
    "pending",
    "expired",
    "wrong-kind",
    "deleted",
    "storage-deleted",
    "replaced",
    "missing",
  ])("rejects %s photos before send", async (state) => {
    const h = setup();
    if (state === "pending") h.grant.committedAt = null as any;
    if (state === "expired") h.grant.expiresAt = new Date(0);
    if (state === "wrong-kind") h.grant.kind = "video";
    if (state === "deleted")
      h.prisma.mediaAsset.findUnique.mockResolvedValue({
        deletedAt: new Date(),
      });
    if (state === "storage-deleted")
      h.prisma.mediaAsset.findUnique.mockResolvedValue({
        r2DeletedAt: new Date(),
      });
    if (state === "replaced")
      h.send.mockResolvedValue({
        ETag: "changed",
        ContentLength: 100,
        ContentType: "image/jpeg",
      });
    if (state === "missing") h.send.mockRejectedValue(new Error("NoSuchKey"));
    await expect(
      h.service.photo("sender", {
        source: "upload",
        kind: "image",
        r2Key: h.grant.r2Key,
      }),
    ).rejects.toThrow("Attach the file again");
  });

  it("does not authorize a cross-user key merely because it has a hash index", async () => {
    const h = setup();
    h.prisma.mediaUploadGrant.findUnique.mockResolvedValue(null);
    await expect(
      h.service.assertCommitAccess("sender", h.grant.r2Key),
    ).rejects.toThrow("Attach the file again");
    h.prisma.mediaContentHash.findUnique.mockResolvedValue({
      r2Key: h.grant.r2Key,
    });
    await expect(
      h.service.assertCommitAccess(
        "sender",
        h.grant.r2Key,
        "same-content-hash",
      ),
    ).resolves.toBeUndefined();
    h.prisma.mediaContentHash.findUnique.mockResolvedValue({
      r2Key: "another-key",
    });
    await expect(
      h.service.assertCommitAccess("sender", h.grant.r2Key, "wrong-hash"),
    ).rejects.toThrow("Attach the file again");
  });

  it("keeps own pre-rollout init compatible and records a final object fingerprint", async () => {
    const h = setup();
    await expect(
      h.service.assertCommitAccess(
        "sender",
        "dev/uploads/sender/images/photo.jpg",
      ),
    ).resolves.toBeUndefined();
    await h.service.committed("sender", h.grant.r2Key, {
      width: 320,
      height: 240,
    });
    expect(h.prisma.mediaUploadGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "sender",
          committedAt: expect.any(Date),
          expiresAt: expect.any(Date),
          kind: "image",
          etag: '"etag"',
          bytes: 100,
        }),
      }),
    );
  });

  it("retains a concurrent committed grant while refreshing an init reservation", async () => {
    const h = setup();
    await h.service.pending("sender", h.grant.r2Key, "image/jpeg");
    expect(h.prisma.mediaUploadGrant.upsert.mock.calls[0][0].update).toEqual({
      expiresAt: expect.any(Date),
    });
  });

  it("commits a parent-bound video thumbnail without requiring an extra client request", async () => {
    const h = setup();
    await h.service.commitThumbnail(
      "sender",
      "dev/uploads/sender/thumbnails/poster.jpg",
    );
    expect(h.storage.getImageInfoAndNormalizeJpegIfNeeded).toHaveBeenCalled();
    expect(h.prisma.mediaUploadGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "image",
          width: 100,
          height: 80,
          committedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("conditionally snapshots mutable aliases and cannot be changed by a later source PUT", async () => {
    const h = setup();
    const input = {
      source: "upload" as const,
      kind: "image" as const,
      r2Key: h.grant.r2Key,
    };
    const accepted = await h.service.photo("sender", input);
    expect(accepted.r2Key).toMatch(
      /^dev\/uploads\/sender\/message-media\/[a-f0-9]{64}\.jpg$/,
    );
    const copy = h.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof CopyObjectCommand);
    expect(copy!.input).toMatchObject({
      Key: accepted.r2Key,
      CopySourceIfMatch: h.grant.etag,
    });
    expect(copy!.input.CopySource).toContain(h.grant.r2Key);
    const canonical =
      h.prisma.mediaUploadGrant.upsert.mock.calls.at(-1)![0].create;
    h.prisma.mediaUploadGrant.findUnique.mockResolvedValue(canonical);
    h.send.mockClear();
    h.send.mockImplementation(async (command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Key === accepted.r2Key
      )
        return {
          ETag: canonical.etag,
          ContentLength: canonical.bytes,
          ContentType: canonical.contentType,
        };
      throw new Error("source overwritten");
    });
    await expect(
      h.service.photo("sender", { ...input, r2Key: accepted.r2Key }),
    ).resolves.toMatchObject({ r2Key: accepted.r2Key });
    expect(
      h.send.mock.calls.some(
        ([command]) => command instanceof CopyObjectCommand,
      ),
    ).toBe(false);
  });

  it("reuses the deterministic snapshot while retries cannot create another message", async () => {
    const h = setup();
    const input = {
      source: "upload" as const,
      kind: "image" as const,
      r2Key: h.grant.r2Key,
    };
    const first = await h.service.photo("sender", input);
    const canonical =
      h.prisma.mediaUploadGrant.upsert.mock.calls.at(-1)![0].create;
    h.prisma.mediaUploadGrant.findUnique.mockImplementation(
      async ({ where }: { where: { userId_r2Key: { r2Key: string } } }) =>
        where.userId_r2Key.r2Key === h.grant.r2Key ? h.grant : canonical,
    );
    h.send.mockClear();
    await expect(h.service.photo("sender", input)).resolves.toMatchObject({
      r2Key: first.r2Key,
    });
    expect(
      h.send.mock.calls.some(
        ([command]) => command instanceof CopyObjectCommand,
      ),
    ).toBe(false);
  });

  it.each(["source changed during copy", "copy failed", "unreadable snapshot"])(
    "fails closed with bounded ownership when %s",
    async (failure) => {
      const h = setup();
      h.send.mockImplementation(async (command) => {
        if (command instanceof CopyObjectCommand) {
          if (failure !== "unreadable snapshot") throw new Error(failure);
          return { CopyObjectResult: { ETag: h.grant.etag } };
        }
        if (command instanceof GetObjectCommand) return {};
        return {
          ETag: h.grant.etag,
          ContentLength: h.grant.bytes,
          ContentType: h.grant.contentType,
        };
      });
      await expect(
        h.service.photo("sender", {
          source: "upload",
          kind: "image",
          r2Key: h.grant.r2Key,
        }),
      ).rejects.toThrow("Attach the file again");
      const pending = h.prisma.mediaUploadGrant.upsert.mock.calls.at(-1)![0];
      expect(pending.create).toMatchObject({
        committedAt: null,
        expiresAt: expect.any(Date),
      });
      expect(
        pending.create.expiresAt.getTime() - Date.now(),
      ).toBeLessThanOrEqual(7 * 86400_000);
    },
  );

  it("binds independently immutable thumbnail ownership to the canonical photo", async () => {
    const h = setup();
    h.grant.thumbnailR2Key = "dev/uploads/sender/thumbnails/thumb.jpg" as any;
    const thumbnail = {
      ...h.grant,
      r2Key: h.grant.thumbnailR2Key,
      thumbnailR2Key: null,
    };
    h.prisma.mediaUploadGrant.findUnique.mockImplementation(
      async ({ where }: { where: { userId_r2Key: { r2Key: string } } }) =>
        where.userId_r2Key.r2Key === h.grant.r2Key
          ? h.grant
          : where.userId_r2Key.r2Key === thumbnail.r2Key
            ? thumbnail
            : null,
    );
    const result = await h.service.photo("sender", {
      source: "upload",
      kind: "image",
      r2Key: h.grant.r2Key,
      thumbnailR2Key: thumbnail.r2Key,
    });
    expect(result.r2Key).toContain("/message-media/");
    expect(result.thumbnailR2Key).toContain("/message-media/");
    expect(result.r2Key).not.toBe(result.thumbnailR2Key);
    const committed = h.prisma.mediaUploadGrant.upsert.mock.calls.filter(
      ([args]: [{ create: { committedAt: Date | null } }]) =>
        args.create.committedAt,
    );
    expect(committed).toHaveLength(2);
    expect(committed.at(-1)![0].create.thumbnailR2Key).toBe(
      result.thumbnailR2Key,
    );
  });

  it("creates a fresh reattachment snapshot after an older snapshot was revoked", async () => {
    const h = setup();
    const input = {
      source: "upload" as const,
      kind: "image" as const,
      r2Key: h.grant.r2Key,
    };
    const previous = await h.service.photo("sender", input);
    h.grant.committedAt = new Date(h.grant.committedAt.getTime() + 1000);
    h.prisma.mediaAsset.findUnique.mockImplementation(
      async ({ where }: { where: { r2Key: string } }) =>
        where.r2Key === previous.r2Key ? { deletedAt: new Date() } : null,
    );
    const reattached = await h.service.photo("sender", input);
    expect(reattached.r2Key).not.toBe(previous.r2Key);
  });
});
