import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { MessagesService } from './messages.service';

const listConversationsSchema = z.object({
  tab: z.enum(['primary', 'requests']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const createConversationSchema = z.object({
  user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
  title: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(2000),
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

const blockUserSchema = z.object({
  user_id: z.string().trim().min(1),
});

const lookupConversationSchema = z.object({
  user_ids: z.array(z.string().trim().min(1)).min(1).max(50),
});

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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
      body: parsed.body,
    });
    return { data: result };
  }

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('conversations/:id/messages')
  async sendMessage(@CurrentUserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    const parsed = sendMessageSchema.parse(body);
    const result = await this.messages.sendMessage({ userId, conversationId: id, body: parsed.body });
    return { data: result };
  }

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
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
