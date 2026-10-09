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
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;
    for (const p of participants) {
      const dto = toMessageDto({
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
