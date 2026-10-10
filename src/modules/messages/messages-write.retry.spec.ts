import { MessagesWriteService } from "./messages-write.service";
import { messageRequestHash } from "./message-request";
import {
  createConversationSchema,
  sendMessageSchema,
} from "./messages.schemas";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function setup() {
  let stored: any = null;
  const sender = {
    id: "sender",
    username: "sender",
    verifiedStatus: "manual",
    premium: false,
    premiumPlus: false,
    siteAdmin: true,
  };
  const conversation = {
    id: "conversation",
    type: "direct",
    directKey: "pair",
    participants: [
      { userId: "sender", status: "accepted", acceptedAt: new Date() },
      { userId: "peer", status: "accepted" },
    ],
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(sender),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: "peer", verifiedStatus: "manual" }]),
    },
    follow: { findMany: jest.fn().mockResolvedValue([]) },
    mediaAsset: { findMany: jest.fn().mockResolvedValue([]) },
    message: {
      findUnique: jest.fn(async () => stored),
      findFirst: jest.fn().mockResolvedValue({ id: "reply" }),
      create: jest.fn(async ({ data }: any) => {
        await Promise.resolve();
        if (data.clientRequestId && stored) throw { code: "P2002" };
        stored = {
          ...data,
          id: "message",
          sender,
          createdAt: new Date(),
          media: [],
          reactions: [],
        };
        return stored;
      }),
    },
    messageConversation: {
      findFirst: jest.fn().mockResolvedValue({ id: "conversation" }),
      create: jest.fn().mockResolvedValue({ id: "conversation" }),
      update: jest.fn(),
    },
    messageParticipant: {
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const support: any = {
    getConversationOrThrow: jest.fn().mockResolvedValue(conversation),
    _getBlockedUserIds: jest.fn().mockResolvedValue(new Set()),
    assertNotBlocked: jest.fn(),
    directKeyFor: () => "pair",
    parseDirectPair: () => ["sender", "peer"],
    emitUnreadCounts: jest.fn(),
    chatConversationType: (type: string) => type,
    logger: { log: jest.fn(), warn: jest.fn() },
  };
  const realtime: any = { emitMessageCreated: jest.fn() };
  const events: any = { emitMessagePushRequested: jest.fn() };
  const effects: any = { dispatch: jest.fn() };
  const jobs: any = { enqueue: jest.fn() };
  const grants: any = {
    photo: jest.fn(async (_user, media) => ({
      ...media,
      width: 640,
      height: 480,
    })),
  };
  const service = new MessagesWriteService(
    prisma,
    { r2: () => null, marvBot: () => ({ enabled: false }) } as any,
    realtime,
    events,
    { capture: jest.fn() } as any,
    jobs,
    { getMarvUserId: async () => null } as any,
    effects,
    support,
    grants,
  );
  return {
    service,
    prisma,
    support,
    realtime,
    events,
    effects,
    jobs,
    grants,
    setStored: (message: any) => {
      stored = message;
    },
  };
}

describe("DM request recovery", () => {
  const input = {
    userId: "sender",
    conversationId: "conversation",
    body: "hello",
    clientRequestId: requestId,
  };
  it("replays a committed send after an ambiguous response and only fans out once", async () => {
    const h = setup();
    const first = await h.service.sendMessage(input);
    const replay = await h.service.sendMessage(input);
    expect(replay).toEqual(first);
    expect(first.message.clientRequestId).toBe(requestId);
    expect(h.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(h.events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
    expect(h.realtime.emitMessageCreated).toHaveBeenCalledTimes(2);
    expect(
      h.realtime.emitMessageCreated.mock.calls.find(
        ([id]: string[]) => id === "peer",
      )[1].message.clientRequestId,
    ).toBeNull();
  });
  it("persists immutable photo identity once and replays without another snapshot", async () => {
    const h = setup();
    const photo = {
      source: "upload" as const,
      kind: "image" as const,
      r2Key: "legacy-photo-alias",
    };
    h.grants.photo.mockResolvedValue({
      ...photo,
      r2Key: "dev/uploads/sender/message-media/snapshot.jpg",
      width: 640,
      height: 480,
    });
    const request = { ...input, media: [photo] };
    const sent = await h.service.sendMessage(request);
    const replay = await h.service.sendMessage(request);
    expect(replay).toEqual(sent);
    expect(h.grants.photo).toHaveBeenCalledTimes(1);
    expect(h.prisma.message.create).toHaveBeenCalledTimes(1);
    expect(
      h.prisma.message.create.mock.calls[0][0].data.media.create[0].r2Key,
    ).toBe("dev/uploads/sender/message-media/snapshot.jpg");
  });
  it("does not create or fan out a message when immutable photo preparation fails", async () => {
    const h = setup();
    h.grants.photo.mockRejectedValue(new Error("Attach the file again."));
    await expect(
      h.service.sendMessage({
        ...input,
        media: [{ source: "upload", kind: "image", r2Key: "alias" }],
      }),
    ).rejects.toThrow("Attach the file again");
    expect(h.prisma.message.create).not.toHaveBeenCalled();
    expect(h.events.emitMessagePushRequested).not.toHaveBeenCalled();
  });
  it("resolves simultaneous sends using the unique database identity", async () => {
    const h = setup();
    const [first, second] = await Promise.all([
      h.service.sendMessage(input),
      h.service.sendMessage(input),
    ]);
    expect(second.message.id).toBe(first.message.id);
    expect(h.events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
    expect(h.support.emitUnreadCounts).toHaveBeenCalledTimes(2);
  });
  it.each([
    { body: "different" },
    { replyToId: "reply" },
    { media: [{ source: "upload", kind: "image", r2Key: "photo" }] },
  ])("rejects a reused ID with changed content %p", async (changed) => {
    const h = setup();
    await h.service.sendMessage(input);
    await expect(
      h.service.sendMessage({ ...input, ...changed } as any),
    ).rejects.toThrow("different message");
    expect(h.events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
  });
  it("rechecks current access before revealing a replay", async () => {
    const h = setup();
    await h.service.sendMessage(input);
    h.support.getConversationOrThrow.mockRejectedValue(
      new Error("Conversation not found"),
    );
    await expect(h.service.sendMessage(input)).rejects.toThrow(
      "Conversation not found",
    );
  });
  it("routes first-message creation retries through the same identity", async () => {
    const h = setup();
    const first = await h.service.sendMessage(input);
    await expect(
      h.service.createConversation({
        userId: "sender",
        recipientUserIds: ["peer"],
        body: "hello",
        clientRequestId: requestId,
      }),
    ).resolves.toEqual({
      conversationId: "conversation",
      message: first.message,
    });
    expect(h.events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
  });
  it("recovers a concurrent direct-conversation creation winner without another send", async () => {
    const h = setup();
    const first = await h.service.sendMessage(input);
    h.prisma.messageConversation.findFirst.mockResolvedValueOnce(null);
    h.prisma.messageConversation.create.mockRejectedValueOnce({
      code: "P2002",
    });
    await expect(
      h.service.createConversation({
        userId: "sender",
        recipientUserIds: ["peer"],
        body: "hello",
        clientRequestId: requestId,
      }),
    ).resolves.toEqual({
      conversationId: "conversation",
      message: first.message,
    });
    expect(h.events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
  });
  it("validates and writes canonical photo metadata on both new-thread and existing-thread paths", async () => {
    const h = setup();
    const media = [
      { source: "upload", kind: "image", r2Key: "photo", width: 999 },
    ] as any;
    await h.service.sendMessage({ ...input, media });
    expect(
      h.prisma.message.create.mock.calls[0][0].data.media.create[0].width,
    ).toBe(640);
    h.prisma.messageConversation.findFirst.mockResolvedValueOnce(null);
    h.setStored(null);
    await h.service.createConversation({
      userId: "sender",
      recipientUserIds: ["peer"],
      body: "hello",
      media,
      clientRequestId: requestId,
    });
    expect(h.grants.photo).toHaveBeenCalledTimes(2);
  });
  it("keeps old clients valid and rejects malformed optional IDs", () => {
    expect(
      sendMessageSchema.parse({ body: "legacy" }).clientRequestId,
    ).toBeUndefined();
    expect(
      createConversationSchema.parse({ user_ids: ["peer"], body: "legacy" })
        .clientRequestId,
    ).toBeUndefined();
    expect(() =>
      sendMessageSchema.parse({ body: "hello", clientRequestId: "not-uuid" }),
    ).toThrow();
    expect(messageRequestHash(" hello ", null, [])).toBe(
      messageRequestHash("hello", null, []),
    );
  });
});
