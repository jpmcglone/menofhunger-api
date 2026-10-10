import { ChannelMessageReadService } from "./channel-message-read.service";

function setup() {
  const referenced = {
    id: "secret",
    name: "leadership",
    displayName: "Leaders only",
    privacy: "private",
    access: [{ userId: "member" }],
  };
  const source = {
    id: "general",
    groupId: "group",
    conversationId: "conversation",
    privacy: "normal",
    defaultPurpose: null,
    archivedAt: null,
  };
  const row: any = {
    id: "message",
    body: "Discuss <#secret>",
    createdAt: new Date(),
    senderId: "author",
    sender: {
      id: "author",
      username: "author",
      name: "Author",
      premium: false,
      premiumPlus: false,
      verifiedStatus: "manual",
      avatarKey: null,
      avatarUpdatedAt: null,
    },
    conversationId: "conversation",
    kind: "text",
    media: [],
    reactions: [],
    deletedForAll: false,
    channelPins: [],
    threadReplies: [],
    _count: { threadReplies: 0 },
    channelRevision: 2,
    channelSequence: 2,
    hiddenPreviews: [],
    threadRootId: null,
    replyTo: {
      id: "quoted",
      body: "Earlier #leadership",
      sender: { username: "author" },
      media: [],
      deletedForAll: false,
    },
  };
  const prisma: any = {
    mediaAsset: { findMany: jest.fn().mockResolvedValue([]) },
    groupChannel: {
      findMany: jest.fn().mockResolvedValue([referenced]),
      findUniqueOrThrow: jest.fn().mockResolvedValue(source),
    },
    message: { findFirst: jest.fn().mockResolvedValue(row) },
    groupChannelThreadState: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const access: any = {
    channel: jest
      .fn()
      .mockResolvedValue({ channel: source, member: { role: "owner" } }),
    recipients: jest.fn().mockResolvedValue([
      { userId: "member", role: "member" },
      { userId: "owner", role: "owner" },
    ]),
  };
  const snapshots = new Map(
    ["member", "owner"].map((id) => [id, { id: "general" }]),
  );
  const realtime: any = { emitGroupChannelMessages: jest.fn() };
  const service = new ChannelMessageReadService(
    prisma,
    access,
    { viewerSnapshots: jest.fn().mockResolvedValue(snapshots) } as any,
    { r2: () => null } as any,
    realtime,
  );
  return { service, row, access, referenced, realtime, prisma, source };
}

describe("channel reference snapshots", () => {
  it("redacts deleted protected media in HTTP and every realtime audience", async () => {
    const h = setup();
    const deletedAt = new Date("2026-10-10T15:00:00Z");
    h.row.media = [
      {
        id: "photo",
        source: "upload",
        kind: "image",
        r2Key: "channel-uploads/photo.jpg",
        thumbnailR2Key: null,
        width: 320,
        height: 240,
        durationSeconds: null,
        mp4Url: null,
        alt: "private description",
        transcriptStatus: "ready",
        transcript: "private recording",
      },
    ];
    h.prisma.mediaAsset.findMany.mockResolvedValue([
      { r2Key: "channel-uploads/photo.jpg", deletedAt },
    ]);
    const page = (
      await h.service.present("owner", "group", "general", [h.row])
    )[0];
    expect(page.media[0]).toMatchObject({
      id: "photo",
      deletedAt: deletedAt.toISOString(),
      url: "",
      thumbnailUrl: null,
      alt: null,
      transcriptStatus: null,
      transcript: null,
    });
    await h.service.broadcast("group", "general", "message");
    for (const [, payload] of h.realtime.emitGroupChannelMessages.mock.calls)
      expect(payload.messages[0].media[0]).toMatchObject({
        deletedAt: deletedAt.toISOString(),
        url: "",
        alt: null,
        transcriptStatus: null,
        transcript: null,
      });
  });
  it("filters HTTP body and quoted preview before returning and refreshes after revocation", async () => {
    const h = setup();
    const own = (
      await h.service.present("member", "group", "general", [h.row])
    )[0];
    expect(own.channelReferences?.[0]).toMatchObject({
      accessible: true,
      name: "leadership",
    });
    expect(own.replyTo?.bodyPreview).toBe("Earlier Private");
    h.referenced.access = [];
    const revoked = (
      await h.service.present("member", "group", "general", [h.row])
    )[0];
    expect(revoked.channelReferences?.[0]).toMatchObject({
      accessible: false,
      channelId: null,
      name: null,
    });
    expect(JSON.stringify(revoked)).not.toMatch(/leadership|Leaders only/);
    expect(h.access.channel).toHaveBeenCalledTimes(4);
  });
  it("emits canonical realtime snapshots with different private metadata for every recipient", async () => {
    const h = setup();
    await h.service.broadcast("group", "general", "message");
    const payload = (userId: string) =>
      h.realtime.emitGroupChannelMessages.mock.calls.find(
        ([id]: [string]) => id === userId,
      )[1];
    expect(payload("member").messages[0].channelReferences[0]).toMatchObject({
      accessible: true,
      name: "leadership",
    });
    expect(payload("owner").messages[0].channelReferences[0]).toMatchObject({
      accessible: false,
      name: null,
      channelId: null,
    });
    expect(JSON.stringify(payload("owner"))).not.toMatch(
      /leadership|Leaders only/,
    );
  });
  it("clears reference metadata with the message tombstone", async () => {
    const h = setup();
    h.row.deletedForAll = true;
    const result = (
      await h.service.present("owner", "group", "general", [h.row])
    )[0];
    expect(result.body).toBe("");
    expect(result.channelReferences).toEqual([]);
    expect(result.replyTo).toBeNull();
  });
  it("searches accessible channel handles using their stable tokens and returns no private-name oracle", async () => {
    const h = setup();
    h.access.member = jest.fn();
    h.access.readableWhere = jest.fn().mockReturnValue({ groupId: "group" });
    h.prisma.message.findMany = jest.fn().mockResolvedValue([h.row]);
    h.prisma.groupChannel.findMany
      .mockResolvedValueOnce([h.source])
      .mockResolvedValueOnce([h.referenced]);
    const inaccessible = await h.service.search("owner", "group", {
      q: "#leadership",
    });
    expect(inaccessible).toEqual({ messages: [], nextCursor: null });
    expect(h.prisma.message.findMany).not.toHaveBeenCalled();
    h.prisma.groupChannel.findMany
      .mockResolvedValueOnce([h.source])
      .mockResolvedValueOnce([h.referenced]);
    const accessible = await h.service.search("member", "group", {
      q: "#leadership",
    });
    expect(h.prisma.message.findMany.mock.calls[0][0].where.body).toEqual({
      contains: "<#secret>",
      mode: "insensitive",
    });
    expect(accessible.messages[0].channelReferences?.[0]).toMatchObject({
      accessible: true,
      name: "leadership",
    });
  });
});
