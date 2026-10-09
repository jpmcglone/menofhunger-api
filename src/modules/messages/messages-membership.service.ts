import { Injectable } from "@nestjs/common";

import { MessagesSupportService } from "./messages-support.service";

@Injectable()
export class MessagesMembershipService {
  constructor(private readonly support: MessagesSupportService) {}

  async listConversationParticipantUserIds(params: {
    userId: string;
    conversationId: string;
  }): Promise<string[]> {
    const { userId, conversationId } = params;
    const conversation = await this.support.getConversationOrThrow({
      userId,
      conversationId,
    });
    return conversation.participants.map((p) => p.userId);
  }
}
