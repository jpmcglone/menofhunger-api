import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";

import { toMessageDto, type MessageDto } from "./message.dto";

import type { MessageCallDto } from "../../common/dto/call.dto";

import {
  MessagesSupportService,
  MESSAGE_INCLUDE,
} from "./messages-support.service";
import type { CallConversationContext } from "./messages.models";

import { toJsonInput } from "../../common/prisma/json";

@Injectable()
export class MessagesCallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly support: MessagesSupportService,
  ) {}

  /**
   * All participant user ids, no viewer check. Internal use only (call lifecycle fan-out
   * fired by timers where there is no acting viewer).
   */
  async listConversationMemberUserIds(
    conversationId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.messageParticipant.findMany({
      where: { conversationId, conversation: { type: { not: "channel" } } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /**
   * Membership + gating snapshot for DM calls. Same visibility rules as
   * `getConversationOrThrow` (viewer must be a participant; blocked peers hide the
   * conversation), plus the tier/admin flags the calls service gates on.
   */
  async getCallConversationContext(params: {
    userId: string;
    conversationId: string;
  }): Promise<CallConversationContext> {
    const { userId, conversationId } = params;
    const blockedUserIds = await this.support._getBlockedUserIds(userId);
    const conversation = await this.prisma.messageConversation.findFirst({
      where: {
        id: conversationId,
        type: { not: "channel" },
        participants: {
          some: { userId },
          ...(blockedUserIds.size > 0
            ? { none: { userId: { in: [...blockedUserIds] } } }
            : {}),
        },
      },
      select: {
        id: true,
        type: true,
        participants: {
          select: {
            userId: true,
            status: true,
            user: {
              select: {
                verifiedStatus: true,
                siteAdmin: true,
                isBot: true,
                bannedAt: true,
              },
            },
          },
        },
      },
    });
    if (!conversation || conversation.type === "channel")
      throw new NotFoundException("Conversation not found.");

    // Callee hasn't accepted this DM: a mutual follow or a shared group chat still counts as a
    // relationship that allows calling. Skip the lookups when the thread is already accepted.
    let relationship: CallConversationContext["relationship"] = null;
    const other =
      conversation.type === "direct"
        ? conversation.participants.find((p) => p.userId !== userId)
        : null;
    if (other && other.status !== "accepted") {
      const [viewerFollows, otherFollows, sharedGroup] = await Promise.all([
        this.prisma.follow.findFirst({
          where: { followerId: userId, followingId: other.userId },
          select: { id: true },
        }),
        this.prisma.follow.findFirst({
          where: { followerId: other.userId, followingId: userId },
          select: { id: true },
        }),
        this.prisma.messageConversation.findFirst({
          where: {
            type: { in: ["group", "crew_wall"] },
            AND: [
              { participants: { some: { userId, status: "accepted" } } },
              {
                participants: {
                  some: { userId: other.userId, status: "accepted" },
                },
              },
            ],
          },
          select: { id: true },
        }),
      ]);
      relationship = {
        mutualFollow: Boolean(viewerFollows && otherFollows),
        sharedGroupConversation: Boolean(sharedGroup),
      };
    }

    return {
      id: conversation.id,
      type: this.support.chatConversationType(conversation.type),
      participants: conversation.participants.map((p) => ({
        userId: p.userId,
        status: p.status,
        verified: (p.user.verifiedStatus ?? "none") !== "none",
        siteAdmin: Boolean(p.user.siteAdmin),
        isBot: Boolean(p.user.isBot),
        banned: Boolean(p.user.bannedAt),
      })),
      relationship,
    };
  }

  /**
   * Insert the one-per-call timeline row. Flows through the normal message plumbing
   * (last-message pointer, `messages:new`, unread badge, push) so a group call start is
   * announced exactly like a message — no separate notification kind.
   */
  async createCallMessage(params: {
    conversationId: string;
    senderId: string;
    body: string;
    call: MessageCallDto;
    /** Direct rings reach iPhones via PushKit; skip the DM alert for recipients that have one. */
    skipPushIfVoipRegistered?: boolean;
  }): Promise<MessageDto> {
    const { conversationId, senderId, body, call } = params;
    const conversation = await this.prisma.messageConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        type: true,
        participants: { select: { userId: true, status: true } },
      },
    });
    if (!conversation || conversation.type === "channel")
      throw new NotFoundException("Conversation not found.");
    const now = new Date();
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId,
          body,
          kind: "call",
          callMeta: toJsonInput(call),
        },
        include: MESSAGE_INCLUDE,
      });
      await tx.messageConversation.update({
        where: { id: conversationId },
        data: { lastMessageId: created.id, lastMessageAt: now },
      });
      await tx.messageParticipant.update({
        where: { conversationId_userId: { conversationId, userId: senderId } },
        data: { lastReadAt: now },
      });
      return created;
    });

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({
      message,
      publicBaseUrl,
      viewerUserId: senderId,
    });
    const participantIds = conversation.participants.map((p) => p.userId);
    for (const id of participantIds) {
      this.presenceRealtime.emitMessageCreated(id, {
        conversationId,
        message: dto,
      });
      this.support.emitUnreadCounts(id);
    }
    const senderName =
      message.sender?.name?.trim() ||
      message.sender?.username?.trim() ||
      "Someone";
    for (const p of conversation.participants) {
      if (p.userId === senderId || p.status === "pending") continue;
      this.events.emitMessagePushRequested({
        recipientUserId: p.userId,
        senderUserId: senderId,
        senderName,
        body,
        conversationId,
        skipIfVoipRegistered: Boolean(params.skipPushIfVoipRegistered),
      });
    }
    return dto;
  }

  async updateCallMessage(params: {
    messageId: string;
    body: string;
    call: MessageCallDto;
  }): Promise<void> {
    const { messageId, body, call } = params;
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, kind: true },
    });
    if (!existing || existing.kind !== "call") return;
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, callMeta: toJsonInput(call) },
      include: MESSAGE_INCLUDE,
    });
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId: existing.conversationId },
      select: { userId: true },
    });
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    for (const p of participants) {
      const dto = toMessageDto({
        message: updated,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageEdited(p.userId, {
        conversationId: existing.conversationId,
        message: dto,
      });
    }
  }
}
