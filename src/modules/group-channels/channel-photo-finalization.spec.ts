import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfigService } from "../app/app-config.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ChannelAccessService } from "./channel-access.service";
import { ChannelMediaService } from "./channel-media.service";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(
    async () => "https://storage.example.test/source-ticket",
  ),
}));

function setup() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5mQAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = {
    id: "upload",
    userId: "sender",
    channelId: "channel",
    kind: "image",
    sourceKey: "dev/channel-uploads/sender/channel/upload/source.png",
    r2Key: "dev/channel-uploads/sender/channel/upload/original.png",
    contentType: "image/png",
    bytes: bytes.length,
    expiresAt: new Date(Date.now() + 86400_000),
    committedAt: null as Date | null,
    width: null as number | null,
    height: null as number | null,
    durationSeconds: null,
  };
  const current = {
    channel: {
      id: "channel",
      conversationId: "conversation",
      privacy: "public",
      archivedAt: null,
      defaultPurpose: null,
    },
    member: { role: "member", user: { premium: false, premiumPlus: false } },
  };
  const access = {
    channel: jest.fn(async () => current),
    lockGroup: jest.fn(),
  };
  const delegate = {
    findFirst: jest.fn(async () => upload),
    create: jest.fn(async ({ data }) => ({ ...data })),
    update: jest.fn(async ({ data }) => Object.assign(upload, data)),
  };
  const tx = {
    groupChannelUpload: delegate,
    mediaAsset: { upsert: jest.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const send = jest.fn(async (command): Promise<Record<string, unknown>> => {
    if (command instanceof HeadObjectCommand)
      return {
        ETag: '"verified"',
        ContentLength: bytes.length,
        ContentType: "image/png",
      };
    if (command instanceof GetObjectCommand)
      return { Body: { transformToByteArray: async () => bytes } };
    return {};
  });
  const service = new ChannelMediaService(
    prisma as unknown as PrismaService,
    access as unknown as ChannelAccessService,
    {
      r2: () => null,
      channelMediaBucket: () => "private",
      isProd: () => false,
    } as unknown as AppConfigService,
  );
  jest
    .spyOn(service as unknown as { storage(): unknown }, "storage")
    .mockReturnValue({ s3: { send }, bucket: "private" });
  return { service, upload, prisma, send, access };
}

describe("protected channel photo finalization", () => {
  it("presigns only source and conditionally snapshots verified bytes to a separate final key", async () => {
    const h = setup();
    await h.service.initialize("sender", "group", "channel", {
      contentType: "image/png",
      bytes: h.upload.bytes,
    });
    const ticket = jest.mocked(getSignedUrl).mock.calls.at(-1)!;
    const put = ticket[1] as PutObjectCommand;
    expect(put.input.Key).toMatch(/\/source\.png$/);
    expect(put.input.Key).not.toContain("/original.");
    const result = await h.service.commit(
      "sender",
      "group",
      "channel",
      "upload",
      {},
    );
    expect(result).toMatchObject({ uploadId: "upload", width: 1, height: 1 });
    const get = h.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof GetObjectCommand);
    const copy = h.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof CopyObjectCommand);
    expect(get!.input.IfMatch).toBe('"verified"');
    expect(copy!.input).toMatchObject({
      Key: h.upload.r2Key,
      CopySourceIfMatch: '"verified"',
    });
    expect(copy!.input.CopySource).toContain(h.upload.sourceKey);
    h.send.mockClear();
    // A valid old ticket can only recreate source. Already-committed finalization
    // returns its saved metadata without reading or overwriting the final key.
    h.send.mockRejectedValue(new Error("source overwritten after commit"));
    await expect(
      h.service.commit("sender", "group", "channel", "upload", {}),
    ).resolves.toEqual(result);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("requires an ETag before any conditional image read or copy", async () => {
    const h = setup();
    h.send.mockResolvedValue({
      ContentLength: h.upload.bytes,
      ContentType: "image/png",
    });
    await expect(
      h.service.commit("sender", "group", "channel", "upload", {}),
    ).rejects.toThrow("does not match");
    expect(
      h.send.mock.calls.some(
        ([command]) =>
          command instanceof GetObjectCommand ||
          command instanceof CopyObjectCommand,
      ),
    ).toBe(false);
  });

  it("does not authorize a channel photo whose source changes between inspection and copy", async () => {
    const h = setup();
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (command) => {
      if (command instanceof CopyObjectCommand)
        throw new Error("PreconditionFailed");
      return original(command);
    });
    await expect(
      h.service.commit("sender", "group", "channel", "upload", {}),
    ).rejects.toThrow("PreconditionFailed");
    expect(h.prisma.groupChannelUpload.update).not.toHaveBeenCalled();
    expect(h.upload.committedAt).toBeNull();
  });
});
