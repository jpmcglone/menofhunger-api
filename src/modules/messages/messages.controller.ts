import { MessagesQueryService } from "./messages-query.service";
import { MessagesWriteService } from "./messages-write.service";
import { MessagesReactionsEditsService } from "./messages-reactions-edits.service";
import { MessagesConversationStateService } from "./messages-conversation-state.service";
import { limitQuery } from "../../common/pagination/cursor-query.schema";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Inject,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "../auth/auth-public-api";
import { CurrentUserId, IsImpersonating } from "../users/users.decorator";
import {
  rateLimitLimit,
  rateLimitTtl,
} from "../../common/throttling/rate-limit.resolver";
import { ALLOWED_REACTIONS } from "../../common/constants/reactions";
import type { MessageMediaInput } from "./messages.models";
import {
  listConversationsSchema,
  searchConversationsSchema,
  listMessagesSchema,
  createConversationSchema,
  sendMessageSchema,
  voicemailSchema,
  blockUserSchema,
  lookupConversationSchema,
  addReactionSchema,
} from "./messages.schemas";

@ApiTags("Messages (Chat)")
@Controller("messages")
// Chat tier rules live in MessagesWriteService.createConversation, not here: an unverified
// user must be able to read and reply in a thread an admin opened to verify them.
// They still cannot start one (createConversation rejects unverified senders).
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(
    @Inject(MessagesQueryService)
    private readonly messagesQueryService: Pick<
      MessagesQueryService,
      | "listConversations"
      | "searchConversations"
      | "getConversation"
      | "listMessages"
      | "messagesAround"
      | "listMessagesNewer"
      | "lookupConversation"
    >,
    @Inject(MessagesWriteService)
    private readonly messagesWriteService: Pick<
      MessagesWriteService,
      "createConversation" | "sendMessage"
    >,
    @Inject(MessagesReactionsEditsService)
    private readonly messagesReactionsEditsService: Pick<
      MessagesReactionsEditsService,
      | "attachCallVoicemail"
      | "addReaction"
      | "removeReaction"
      | "editMessage"
      | "deleteMessageForAll"
    >,
    @Inject(MessagesConversationStateService)
    private readonly messagesConversationStateService: Pick<
      MessagesConversationStateService,
      | "markRead"
      | "acceptConversation"
      | "deleteConversation"
      | "deleteMessageForMe"
      | "restoreMessageForMe"
      | "muteConversation"
      | "unmuteConversation"
      | "getUnreadSummary"
      | "listBlocks"
      | "blockUser"
      | "unblockUser"
    >,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations")
  async listConversations(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ) {
    const parsed = listConversationsSchema.parse(query);
    const result = await this.messagesQueryService.listConversations({
      userId,
      tab: parsed.tab ?? "primary",
      limit: parsed.limit ?? undefined,
      cursor: parsed.cursor ?? null,
    });
    return {
      data: result.conversations,
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 120),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations/search")
  async searchConversations(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ) {
    const parsed = searchConversationsSchema.parse(query);
    const result = await this.messagesQueryService.searchConversations({
      userId,
      query: parsed.q,
      limit: parsed.limit ?? undefined,
    });
    return { data: result.conversations };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations/:id")
  async getConversation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    const result = await this.messagesQueryService.getConversation({
      userId,
      conversationId: id,
    });
    return {
      data: { conversation: result.conversation, messages: result.messages },
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations/:id/messages")
  async listMessages(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    const parsed = listMessagesSchema.parse(query);
    const result = await this.messagesQueryService.listMessages({
      userId,
      conversationId: id,
      limit: parsed.limit ?? undefined,
      cursor: parsed.cursor ?? null,
    });
    return {
      data: result.messages,
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations/:id/messages/around/:msgId")
  async messagesAround(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Param("msgId") msgId: string,
  ) {
    const result = await this.messagesQueryService.messagesAround({
      userId,
      conversationId: id,
      messageId: msgId,
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("conversations/:id/messages/newer")
  async listMessagesNewer(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    const parsed = z
      .object({
        cursor: z.string().min(1),
        limit: limitQuery(50),
      })
      .parse(query);
    const result = await this.messagesQueryService.listMessagesNewer({
      userId,
      conversationId: id,
      cursor: parsed.cursor,
      limit: parsed.limit ?? undefined,
    });
    return {
      data: result.messages,
      pagination: { newerCursor: result.newerCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations")
  async createConversation(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = createConversationSchema.parse(body);
    const result = await this.messagesWriteService.createConversation({
      userId,
      recipientUserIds: parsed.user_ids,
      clientRequestId: parsed.clientRequestId,
      title: parsed.title ?? null,
      body: parsed.body ?? "",
      media: (parsed.media ?? []) as MessageMediaInput[],
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Post("lookup")
  async lookupConversation(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = lookupConversationSchema.parse(body);
    const result = await this.messagesQueryService.lookupConversation({
      userId,
      recipientUserIds: parsed.user_ids,
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:id/messages")
  async sendMessage(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = sendMessageSchema.parse(body);
    const result = await this.messagesWriteService.sendMessage({
      userId,
      conversationId: id,
      body: parsed.body ?? "",
      clientRequestId: parsed.clientRequestId,
      replyToId: parsed.replyToId ?? null,
      media: (parsed.media ?? []) as MessageMediaInput[],
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 30),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:id/messages/:messageId/voicemail")
  async attachCallVoicemail(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body() body: unknown,
  ) {
    const parsed = voicemailSchema.parse(body);
    const result = await this.messagesReactionsEditsService.attachCallVoicemail(
      {
        userId,
        conversationId: id,
        messageId,
        media: parsed as MessageMediaInput,
      },
    );
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 180),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:id/mark-read")
  async markRead(
    @CurrentUserId() userId: string,
    @IsImpersonating() isImpersonating: boolean,
    @Param("id") id: string,
  ) {
    // Marking read stamps `lastReadAt` and emits `messages:read` to the other participant,
    // so an admin opening someone's DMs would show the sender a read receipt that never
    // happened. Only this passive signal is suppressed — sending a message or accepting a
    // request still marks read, because those are deliberate actions the admin took.
    if (isImpersonating) return { data: {} };
    await this.messagesConversationStateService.markRead({
      userId,
      conversationId: id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:id/accept")
  async acceptConversation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    await this.messagesConversationStateService.acceptConversation({
      userId,
      conversationId: id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("conversations/:id")
  async deleteConversation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    await this.messagesConversationStateService.deleteConversation({
      userId,
      conversationId: id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("reactions")
  listReactions() {
    return { data: ALLOWED_REACTIONS };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 120),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:convId/messages/:msgId/reactions")
  async addReaction(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
    @Body() body: unknown,
  ) {
    const parsed = addReactionSchema.parse(body);
    const result = await this.messagesReactionsEditsService.addReaction({
      userId,
      conversationId: convId,
      messageId: msgId,
      reactionId: parsed.reactionId,
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 120),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("conversations/:convId/messages/:msgId/reactions/:reactionId")
  async removeReaction(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
    @Param("reactionId") reactionId: string,
  ) {
    await this.messagesReactionsEditsService.removeReaction({
      userId,
      conversationId: convId,
      messageId: msgId,
      reactionId,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("conversations/:convId/messages/:msgId")
  async deleteMessage(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
  ) {
    await this.messagesConversationStateService.deleteMessageForMe({
      userId,
      conversationId: convId,
      messageId: msgId,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:convId/messages/:msgId/restore")
  async restoreMessage(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
  ) {
    await this.messagesConversationStateService.restoreMessageForMe({
      userId,
      conversationId: convId,
      messageId: msgId,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("conversations/:id/mute")
  async muteConversation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    await this.messagesConversationStateService.muteConversation({
      userId,
      conversationId: id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("conversations/:id/mute")
  async unmuteConversation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
  ) {
    await this.messagesConversationStateService.unmuteConversation({
      userId,
      conversationId: id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Patch("conversations/:convId/messages/:msgId")
  async editMessage(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ body: z.string().trim().min(1).max(2000) })
      .parse(body);
    await this.messagesReactionsEditsService.editMessage({
      userId,
      conversationId: convId,
      messageId: msgId,
      body: parsed.body,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 30),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("conversations/:convId/messages/:msgId/all")
  async deleteMessageForAll(
    @CurrentUserId() userId: string,
    @Param("convId") convId: string,
    @Param("msgId") msgId: string,
  ) {
    await this.messagesReactionsEditsService.deleteMessageForAll({
      userId,
      conversationId: convId,
      messageId: msgId,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 240),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("unread-count")
  async getUnreadCount(@CurrentUserId() userId: string) {
    const counts =
      await this.messagesConversationStateService.getUnreadSummary(userId);
    return { data: { primary: counts.primary, requests: counts.requests } };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("publicRead", 120),
      ttl: rateLimitTtl("publicRead", 60),
    },
  })
  @Get("blocks")
  async listBlocks(@CurrentUserId() userId: string) {
    const blocks = await this.messagesConversationStateService.listBlocks({
      userId,
    });
    return { data: blocks };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Post("blocks")
  async blockUser(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = blockUserSchema.parse(body);
    await this.messagesConversationStateService.blockUser({
      userId,
      targetUserId: parsed.user_id,
    });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit("interact", 60),
      ttl: rateLimitTtl("interact", 60),
    },
  })
  @Delete("blocks/:id")
  async unblockUser(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.messagesConversationStateService.unblockUser({
      userId,
      targetUserId: id,
    });
    return { data: {} };
  }
}
