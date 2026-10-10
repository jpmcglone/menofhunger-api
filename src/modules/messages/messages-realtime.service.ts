import { messageMediaDeletedAt } from "./message-media-state";
import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { AppConfigService } from "../app/app-config.service";
import { PresenceRealtimeService } from "../presence/presence-realtime.service";

import { toMessageDto } from "./message.dto";

import { MESSAGE_INCLUDE } from "./messages-support.service";

@Injectable()
export class MessagesRealtimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
    private readonly presenceRealtime: PresenceRealtimeService,
  ) {}

  /**
   * Patch the call row in place as the call progresses. Emits `messages:edited` so open
   * chats re-render the row; deliberately leaves `editedAt` null (this isn't a user edit).
   */
  /** Re-emit a message to its participants after a server-side change such as a finished transcript. */
  async rebroadcastMessage(messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: MESSAGE_INCLUDE,
    });
    if (!message) return;
    const participants = await this.prisma.messageParticipant.findMany({
      where: { conversationId: message.conversationId },
      select: { userId: true },
    });
    const mediaDeletedAt = await messageMediaDeletedAt(this.prisma, [message]);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    for (const p of participants) {
      // Recheck current membership and both block directions before exposing a full
      // snapshot. Unlike an interactive read, fan-out must never restore a removed
      // direct-chat participant as a side effect.
      const blocks = await this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: p.userId }, { blockedId: p.userId }] },
        select: { blockerId: true, blockedId: true },
      });
      const blockedIds = blocks.map((block) =>
        block.blockerId === p.userId ? block.blockedId : block.blockerId,
      );
      const visible = await this.prisma.messageConversation.findFirst({
        where: {
          id: message.conversationId,
          type: { not: "channel" },
          participants: {
            some: { userId: p.userId },
            ...(blockedIds.length
              ? { none: { userId: { in: blockedIds } } }
              : {}),
          },
        },
        select: { id: true },
      });
      if (!visible) continue;
      const dto = toMessageDto({
        mediaDeletedAt,
        message,
        publicBaseUrl,
        viewerUserId: p.userId,
      });
      this.presenceRealtime.emitMessageEdited(p.userId, {
        conversationId: message.conversationId,
        message: dto,
      });
    }
  }
}
