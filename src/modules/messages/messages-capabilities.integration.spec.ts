import { AuthGuard } from "../auth/auth-public-api";
import { Test } from "@nestjs/testing";
import { MessagesController } from "./messages.controller";
import { MessagesQueryService } from "./messages-query.service";
import { MessagesWriteService } from "./messages-write.service";
import { MessagesConversationStateService } from "./messages-conversation-state.service";
import { MessagesReactionsEditsService } from "./messages-reactions-edits.service";
import { MessagesCallsService } from "./messages-calls.service";
import { MessagesSupportService } from "./messages-support.service";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";

describe("Messages focused capability injection", () => {
  it("routes chat reads, writes, and unread state through independent capabilities", async () => {
    const query = {
      listConversations: jest.fn().mockResolvedValue({
        conversations: [{ id: "conversation" }],
        nextCursor: null,
      }),
    };
    const write = {
      sendMessage: jest.fn().mockResolvedValue({ message: { id: "message" } }),
    };
    const state = {
      getUnreadSummary: jest
        .fn()
        .mockResolvedValue({ primary: 2, requests: 1 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        MessagesController,
        { provide: MessagesQueryService, useValue: query },
        { provide: MessagesWriteService, useValue: write },
        { provide: MessagesConversationStateService, useValue: state },
        { provide: MessagesReactionsEditsService, useValue: {} },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    try {
      const controller = module.get(MessagesController);
      expect(
        await controller.listConversations("viewer", { tab: "primary" }),
      ).toEqual({
        data: [{ id: "conversation" }],
        pagination: { nextCursor: null },
      });
      expect(
        await controller.sendMessage("viewer", "conversation", {
          body: "hello",
        }),
      ).toEqual({ data: { message: { id: "message" } } });
      expect(write.sendMessage).toHaveBeenCalledWith({
        userId: "viewer",
        conversationId: "conversation",
        body: "hello",
        replyToId: null,
        media: [],
      });
      expect(await controller.getUnreadCount("viewer")).toEqual({
        data: { primary: 2, requests: 1 },
      });
      expect(state.getUnreadSummary).toHaveBeenCalledWith("viewer");
    } finally {
      await module.close();
    }
  });

  it("keeps call message commits, realtime audience, and accepted-recipient pushes together", async () => {
    const message = {
      id: "call-message",
      conversationId: "conversation",
      senderId: "caller",
      body: "Calling",
      kind: "call",
      createdAt: new Date("2026-10-09"),
      sender: { id: "caller", username: "caller", name: "Caller" },
      media: [],
      reactions: [],
    };
    const prisma = {
      messageConversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: "conversation",
          type: "group",
          participants: [
            { userId: "caller", status: "accepted" },
            { userId: "accepted", status: "accepted" },
            { userId: "pending", status: "pending" },
          ],
        }),
        update: jest.fn(),
      },
      message: { create: jest.fn().mockResolvedValue(message) },
      messageParticipant: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    );
    const realtime = { emitMessageCreated: jest.fn() };
    const events = { emitMessagePushRequested: jest.fn() };
    const support = { emitUnreadCounts: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        MessagesCallsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppConfigService, useValue: { r2: () => null } },
        { provide: PresenceRealtimeService, useValue: realtime },
        { provide: DomainEventsService, useValue: events },
        { provide: MessagesSupportService, useValue: support },
      ],
    }).compile();
    try {
      await module.get(MessagesCallsService).createCallMessage({
        conversationId: "conversation",
        senderId: "caller",
        body: "Calling",
        call: {
          callId: "call",
          type: "audio",
          outcome: "started",
          durationSeconds: null,
          peakParticipantCount: 1,
        },
        skipPushIfVoipRegistered: true,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.messageConversation.update).toHaveBeenCalledWith({
        where: { id: "conversation" },
        data: {
          lastMessageId: "call-message",
          lastMessageAt: expect.any(Date),
        },
      });
      expect(
        realtime.emitMessageCreated.mock.calls.map(([userId]) => userId),
      ).toEqual(["caller", "accepted", "pending"]);
      expect(
        support.emitUnreadCounts.mock.calls.map(([userId]) => userId),
      ).toEqual(["caller", "accepted", "pending"]);
      expect(events.emitMessagePushRequested).toHaveBeenCalledTimes(1);
      expect(events.emitMessagePushRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: "accepted",
          skipIfVoipRegistered: true,
        }),
      );
    } finally {
      await module.close();
    }
  });
});
