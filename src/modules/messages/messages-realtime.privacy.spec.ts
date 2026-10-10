import type { AppConfigService } from "../app/app-config.service";
import type { PresenceRealtimeService } from "../presence/presence-realtime.service";
import type { PrismaService } from "../prisma/prisma.service";
import { MessagesRealtimeService } from "./messages-realtime.service";

function setup() {
  const current = new Set(["sender", "peer", "other"]);
  const blocks: Array<{ blockerId: string; blockedId: string }> = [];
  const message = {
    id: "message",
    conversationId: "conversation",
    senderId: "sender",
    sender: { id: "sender", username: "sender" },
    clientRequestId: "request-id",
    createdAt: new Date(),
    body: "private body",
    media: [
      { id: "photo", source: "upload", kind: "image", r2Key: "photo-key" },
    ],
    reactions: [],
  };
  const emitMessageEdited = jest.fn();
  const prisma = {
    message: { findUnique: jest.fn(async () => message) },
    messageParticipant: {
      // The enumerated list can become stale while storage state is loaded.
      findMany: jest.fn(async () =>
        ["sender", "peer", "other", "removed"].map((userId) => ({ userId })),
      ),
    },
    userBlock: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { OR: Array<{ blockerId?: string; blockedId?: string }> };
        }) => {
          const viewer = where.OR[0].blockerId;
          return blocks.filter(
            (block) => block.blockerId === viewer || block.blockedId === viewer,
          );
        },
      ),
    },
    messageConversation: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            participants: {
              some: { userId: string };
              none?: { userId: { in: string[] } };
            };
          };
        }) =>
          current.has(where.participants.some.userId) &&
          !where.participants.none?.userId.in.some((id) => current.has(id))
            ? { id: "conversation" }
            : null,
      ),
    },
    mediaAsset: {
      findMany: jest.fn(async () => [
        {
          r2Key: "photo-key",
          deletedAt: new Date("2026-10-10T15:00:00Z"),
          r2DeletedAt: null,
        },
      ]),
    },
  };
  const service = new MessagesRealtimeService(
    prisma as unknown as PrismaService,
    {
      r2: () => ({ publicBaseUrl: "https://assets.example.com" }),
    } as unknown as AppConfigService,
    { emitMessageEdited } as unknown as PresenceRealtimeService,
  );
  return { current, blocks, message, emitMessageEdited, prisma, service };
}

describe("server-side DM snapshot recipient privacy", () => {
  it("redacts revoked media, sends request identity only to sender, and never restores a removed participant", async () => {
    const h = setup();
    await h.service.rebroadcastMessage("message");
    expect(h.emitMessageEdited.mock.calls.map(([id]) => id)).toEqual([
      "sender",
      "peer",
      "other",
    ]);
    expect(h.emitMessageEdited.mock.calls[0][1].message.clientRequestId).toBe(
      "request-id",
    );
    expect(
      h.emitMessageEdited.mock.calls[1][1].message.clientRequestId,
    ).toBeNull();
    for (const [, event] of h.emitMessageEdited.mock.calls)
      expect(event.message.media[0]).toMatchObject({
        id: "photo",
        url: "",
        deletedAt: "2026-10-10T15:00:00.000Z",
      });
    expect(h.prisma.messageConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          participants: { some: { userId: "removed" } },
        }),
      }),
    );
  });

  it.each(["viewer blocks peer", "peer blocks viewer"])(
    "withholds the full snapshot when %s",
    async (direction) => {
      const h = setup();
      h.blocks.push(
        direction === "viewer blocks peer"
          ? { blockerId: "sender", blockedId: "peer" }
          : { blockerId: "peer", blockedId: "sender" },
      );
      await h.service.rebroadcastMessage("message");
      // Both blocked participants lose access to this conversation; unrelated group
      // members still receive a redacted update, matching interactive read policy.
      expect(h.emitMessageEdited.mock.calls.map(([id]) => id)).toEqual([
        "other",
      ]);
      expect(h.prisma.messageConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            participants: {
              some: { userId: "sender" },
              none: { userId: { in: ["peer"] } },
            },
          }),
        }),
      );
    },
  );
});
