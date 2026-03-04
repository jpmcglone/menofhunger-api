import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { ALLOWED_REACTIONS } from '../../common/constants/reactions';
import { MessagesService, type MessageMediaInput } from './messages.service';

const listConversationsSchema = z.object({
  tab: z.enum(['primary', 'requests']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const searchConversationsSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const messageMediaSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('upload'),
    kind: z.enum(['image', 'gif', 'video']),
    r2Key: z.string().min(1),
    thumbnailR2Key: z.string().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    durationSeconds: z.coerce.number().min(0).optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
  z.object({
    source: z.literal('giphy'),
    kind: z.literal('gif'),
    url: z.string().url(),
    mp4Url: z.string().url().optional().nullable(),
    width: z.coerce.number().int().positive().optional().nullable(),
    height: z.coerce.number().int().positive().optional().nullable(),
    alt: z.string().max(500).optional().nullable(),
  }),
]);

const createConversationSchema = z
  .object({
    user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(2000).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((val) => (val.body?.trim()?.length ?? 0) > 0 || (val.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

const sendMessageSchema = z
  .object({
    body: z.string().trim().max(2000).optional(),
    replyToId: z.string().trim().min(1).optional(),
    media: z.array(messageMediaSchema).max(1).optional(),
  })
  .refine((val) => (val.body?.trim()?.length ?? 0) > 0 || (val.media?.length ?? 0) > 0, {
    message: 'Message must have a body or media.',
  });

const blockUserSchema = z.object({
  user_id: z.string().trim().min(1),
});

const lookupConversationSchema = z.object({
  user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
});

const addReactionSchema = z.object({
  reactionId: z.string().trim().min(1),
});

@Controller('messages')
@UseGuards(AuthGuard, VerifiedGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations')
  async listConversations(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = listConversationsSchema.parse(query);
    const result = await this.messages.listConversations({
      userId,
      tab: parsed.tab ?? 'primary',
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
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations/search')
  async searchConversations(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = searchConversationsSchema.parse(query);
    const result = await this.messages.searchConversations({
      userId,
      query: parsed.q,
      limit: parsed.limit ?? undefined,
    });
    return { data: result.conversations };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations/:id')
  async getConversation(@CurrentUserId() userId: string, @Param('id') id: string) {
    const result = await this.messages.getConversation({ userId, conversationId: id });
    return {
      data: { conversation: result.conversation, messages: result.messages },
      pagination: { nextCursor: result.nextCursor },
    };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations/:id/messages')
  async listMessages(@CurrentUserId() userId: string, @Param('id') id: string, @Query() query: unknown) {
    const parsed = listMessagesSchema.parse(query);
    const result = await this.messages.listMessages({
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
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations/:id/messages/around/:msgId')
  async messagesAround(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('msgId') msgId: string,
  ) {
    const result = await this.messages.messagesAround({ userId, conversationId: id, messageId: msgId });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('conversations/:id/messages/newer')
  async listMessagesNewer(@CurrentUserId() userId: string, @Param('id') id: string, @Query() query: unknown) {
    const parsed = z.object({
      cursor: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }).parse(query);
    const result = await this.messages.listMessagesNewer({
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
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations')
  async createConversation(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createConversationSchema.parse(body);
    const result = await this.messages.createConversation({
      userId,
      recipientUserIds: parsed.user_ids,
      title: parsed.title ?? null,
      body: parsed.body ?? '',
      media: (parsed.media ?? []) as MessageMediaInput[],
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Post('lookup')
  async lookupConversation(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = lookupConversationSchema.parse(body);
    const result = await this.messages.lookupConversation({
      userId,
      recipientUserIds: parsed.user_ids,
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:id/messages')
  async sendMessage(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = sendMessageSchema.parse(body);
    const result = await this.messages.sendMessage({
      userId,
      conversationId: id,
      body: parsed.body ?? '',
      replyToId: parsed.replyToId ?? null,
      media: (parsed.media ?? []) as MessageMediaInput[],
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:id/mark-read')
  async markRead(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.markRead({ userId, conversationId: id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:id/accept')
  async acceptConversation(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.acceptConversation({ userId, conversationId: id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('conversations/:id')
  async deleteConversation(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.deleteConversation({ userId, conversationId: id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('reactions')
  listReactions() {
    return { data: ALLOWED_REACTIONS };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:convId/messages/:msgId/reactions')
  async addReaction(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
    @Body() body: unknown,
  ) {
    const parsed = addReactionSchema.parse(body);
    const result = await this.messages.addReaction({ userId, conversationId: convId, messageId: msgId, reactionId: parsed.reactionId });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('conversations/:convId/messages/:msgId/reactions/:reactionId')
  async removeReaction(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
    @Param('reactionId') reactionId: string,
  ) {
    await this.messages.removeReaction({ userId, conversationId: convId, messageId: msgId, reactionId });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('conversations/:convId/messages/:msgId')
  async deleteMessage(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
  ) {
    await this.messages.deleteMessageForMe({ userId, conversationId: convId, messageId: msgId });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:convId/messages/:msgId/restore')
  async restoreMessage(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
  ) {
    await this.messages.restoreMessageForMe({ userId, conversationId: convId, messageId: msgId });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:id/mute')
  async muteConversation(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.muteConversation({ userId, conversationId: id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('conversations/:id/mute')
  async unmuteConversation(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.unmuteConversation({ userId, conversationId: id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch('conversations/:convId/messages/:msgId')
  async editMessage(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ body: z.string().trim().min(1).max(2000) }).parse(body);
    await this.messages.editMessage({ userId, conversationId: convId, messageId: msgId, body: parsed.body });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 30),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('conversations/:convId/messages/:msgId/all')
  async deleteMessageForAll(
    @CurrentUserId() userId: string,
    @Param('convId') convId: string,
    @Param('msgId') msgId: string,
  ) {
    await this.messages.deleteMessageForAll({ userId, conversationId: convId, messageId: msgId });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('unread-count')
  async getUnreadCount(@CurrentUserId() userId: string) {
    const counts = await this.messages.getUnreadSummary(userId);
    return { data: { primary: counts.primary, requests: counts.requests } };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('blocks')
  async listBlocks(@CurrentUserId() userId: string) {
    const blocks = await this.messages.listBlocks({ userId });
    return { data: blocks };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('blocks')
  async blockUser(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = blockUserSchema.parse(body);
    await this.messages.blockUser({ userId, targetUserId: parsed.user_id });
    return { data: {} };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 60),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete('blocks/:id')
  async unblockUser(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.messages.unblockUser({ userId, targetUserId: id });
    return { data: {} };
  }
}
