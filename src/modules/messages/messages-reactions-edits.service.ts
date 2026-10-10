import { messageMediaDeletedAt } from "./message-media-state";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";
import { DomainEventsService } from "../events/domain-events.service";
import { MessagesSupportService } from "./messages-support.service";
import { assertPublishableText } from "../../common/moderation/content-filter";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { findReactionById } from "../../common/constants/reactions";
import { toMessageDto, toMessageCallDto, type MessageDto } from "./message.dto";
import {
  MESSAGE_INCLUDE,
  MESSAGE_EDIT_WINDOW_MS,
} from "./messages-support.service";
import {
  messageMediaCreateData,
  type MessageMediaInput,
} from "./messages.models";

@Injectable()
export class MessagesReactionsEditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
    private readonly events: DomainEventsService,
    private readonly support: MessagesSupportService,
  ) {}

  async addReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<MessageDto> {
    const { userId, conversationId, messageId, reactionId } = params;

    const reaction = findReactionById(reactionId);
    if (!reaction) throw new BadRequestException("Invalid reaction.");

    await this.support.getConversationOrThrow({ userId, conversationId });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException("Message not found.");

    await this.prisma.messageReaction.upsert({
      where: { messageId_userId_reactionId: { messageId, userId, reactionId } },
      create: { messageId, userId, reactionId, emoji: reaction.emoji },
      update: {},
    });

    const updated = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: MESSAGE_INCLUDE,
    });
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [updated]);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({
      mediaDeletedAt,
      message: updated,
      publicBaseUrl,
      viewerUserId: userId,
    });

    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({
        mediaDeletedAt,
        message: updated,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, {
        conversationId,
        message: participantDto,
      });
    }

    return dto;
  }

  async removeReaction(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    reactionId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId, reactionId } = params;

    await this.support.getConversationOrThrow({ userId, conversationId });

    await this.prisma.messageReaction.deleteMany({
      where: { messageId, userId, reactionId },
    });

    const updated = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!updated) return;

    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [updated]);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    for (const p of participants) {
      const participantDto = toMessageDto({
        mediaDeletedAt,
        message: updated,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageReactionUpdated(p.userId, {
        conversationId,
        message: participantDto,
      });
    }
  }

  async attachCallVoicemail(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    media: MessageMediaInput;
  }) {
    const { userId, conversationId, messageId, media } = params;
    if (media.source !== "upload" || media.kind !== "video") {
      throw new BadRequestException("Voicemail must be a video upload.");
    }

    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });
    if (conversation.type !== "direct") {
      throw new BadRequestException("Voicemail is only for direct calls.");
    }

    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: { media: true },
    });
    if (!existing || existing.kind !== "call")
      throw new NotFoundException("Call message not found.");
    if (existing.senderId !== userId) {
      throw new ForbiddenException(
        "Only the caller can leave a video message.",
      );
    }
    const call = toMessageCallDto(existing.callMeta);
    if (!call || call.outcome !== "missed") {
      throw new BadRequestException(
        "A video message can only be left on a missed call.",
      );
    }
    if ((existing.media?.length ?? 0) > 0) {
      throw new BadRequestException("This call already has a video message.");
    }

    const [create] = messageMediaCreateData([media]);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.messageMedia.create({
        data: { messageId, ...create },
      });
      return tx.message.update({
        where: { id: messageId },
        data: { body: "Missed video call · Left a message" },
        include: MESSAGE_INCLUDE,
      });
    });

    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [updated]);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const dto = toMessageDto({
      mediaDeletedAt,
      message: updated,
      publicBaseUrl,
      viewerUserId: userId,
    });
    for (const p of conversation.participants) {
      const viewerDto = toMessageDto({
        mediaDeletedAt,
        message: updated,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageEdited(p.userId, {
        conversationId,
        message: viewerDto,
      });
    }
    const senderName =
      updated.sender?.name?.trim() ||
      updated.sender?.username?.trim() ||
      "Someone";
    for (const recipient of conversation.participants.filter(
      (p) => p.userId !== userId && p.status !== "pending",
    )) {
      this.events.emitMessagePushRequested({
        recipientUserId: recipient.userId,
        senderUserId: userId,
        senderName,
        body: "📹 Left you a video message",
        conversationId,
      });
    }
    return dto;
  }

  async editMessage(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    body: string;
  }): Promise<void> {
    assertPublishableText(params.body);
    const { userId, conversationId, messageId, body } = params;

    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      include: MESSAGE_INCLUDE,
    });
    if (!message) throw new NotFoundException("Message not found.");
    if (message.senderId !== userId)
      throw new ForbiddenException("You can only edit your own messages.");
    if (message.deletedForAll)
      throw new BadRequestException("Cannot edit a deleted message.");

    const ageMs = Date.now() - message.createdAt.getTime();
    if (ageMs > MESSAGE_EDIT_WINDOW_MS) {
      throw new BadRequestException(
        "Messages can only be edited within 15 minutes of sending.",
      );
    }

    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    const now = new Date();
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { body, editedAt: now },
      include: MESSAGE_INCLUDE,
    });

    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [updated]);
    for (const p of conversation.participants) {
      const dto = toMessageDto({
        mediaDeletedAt,
        message: updated,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageEdited(p.userId, {
        conversationId,
        message: dto,
      });
    }
  }

  async deleteMessageForAll(params: {
    userId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const { userId, conversationId, messageId } = params;

    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });

    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { id: true, senderId: true, deletedForAll: true },
    });
    if (!message) throw new NotFoundException("Message not found.");
    if (message.senderId !== userId)
      throw new ForbiddenException("You can only delete your own messages.");
    if (message.deletedForAll) return; // idempotent

    const now = new Date();
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deletedForAll: true, deletedForAllAt: now },
    });

    if (conversation.lastMessageId === messageId) {
      const prev = await this.prisma.message.findFirst({
        where: { conversationId, deletedForAll: false },
        orderBy: { createdAt: "desc" },
        select: { id: true, body: true, createdAt: true, senderId: true },
      });
      await this.prisma.messageConversation.update({
        where: { id: conversationId },
        data: {
          lastMessageId: prev?.id ?? null,
          lastMessageAt: prev?.createdAt ?? null,
        },
      });
    }

    for (const p of conversation.participants) {
      this.presenceRealtime.emitMessageDeletedForAll(p.userId, {
        conversationId,
        messageId,
      });
    }
  }
}
