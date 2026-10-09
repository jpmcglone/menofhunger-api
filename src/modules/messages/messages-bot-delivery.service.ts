import { BadRequestException, Injectable } from "@nestjs/common";

import { type MessageDto } from "./message.dto";

import { MESSAGE_BODY_MAX } from "./messages-support.service";
import { type MessageMediaInput } from "./messages.models";

import { MessagesBotDmService } from "./messages-bot-dm.service";

import { MessagesWriteService } from "./messages-write.service";

@Injectable()
export class MessagesBotDeliveryService {
  constructor(
    private readonly botDm: MessagesBotDmService,
    private readonly write: MessagesWriteService,
  ) {}

  async ensureBotDirectConversation(params: {
    botUserId: string;
    recipientUserId: string;
  }): Promise<string | null> {
    return this.botDm.ensureBotDirectConversation(params);
  }

  async sendBotDirectMessage(params: {
    botUserId: string;
    recipientUserId: string;
    body: string;
    media?: MessageMediaInput[];
  }): Promise<{ conversationId: string; message: MessageDto } | null> {
    const { botUserId, recipientUserId } = params;
    const trimmed = (params.body ?? "").trim();
    const media = params.media ?? [];
    if (!trimmed && media.length === 0)
      throw new BadRequestException("Message must have a body or media.");
    if (trimmed.length > MESSAGE_BODY_MAX)
      throw new BadRequestException("Message body is too long.");

    if (botUserId === recipientUserId) {
      throw new BadRequestException("A bot cannot DM itself.");
    }

    const conversationId = await this.ensureBotDirectConversation({
      botUserId,
      recipientUserId,
    });
    if (!conversationId) return null;

    const sent = await this.write.sendMessage({
      userId: botUserId,
      conversationId,
      body: trimmed,
      media,
    });
    return { conversationId, message: sent.message };
  }
}
