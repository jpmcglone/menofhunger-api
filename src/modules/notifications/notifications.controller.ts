import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { NotificationsService } from './notifications.service';
import { setReadCache } from '../../common/http-cache';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const markReadBodySchema = z.object({
  post_id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
}).refine((d) => d.post_id ?? d.user_id, { message: 'At least one of post_id or user_id is required' });

const pushSubscribeBodySchema = z.object({
  endpoint: z.string().trim().min(1),
  keys: z.object({
    p256dh: z.string().trim().min(1),
    auth: z.string().trim().min(1),
  }),
  user_agent: z.string().trim().optional(),
});

const pushUnsubscribeBodySchema = z.object({
  endpoint: z.string().trim().min(1),
});

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ) {
    const parsed = listQuerySchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.notifications.list({
      recipientUserId: userId,
      limit,
      cursor,
    });
    return {
      data: res.notifications,
      pagination: {
        nextCursor: res.nextCursor,
        undeliveredCount: res.undeliveredCount,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('unread-count')
  async getUnreadCount(
    @CurrentUserId() userId: string,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    setReadCache(httpRes, { viewerUserId: userId, privateMaxAgeSeconds: 5, varyCookie: false });
    const count = await this.notifications.getUndeliveredCount(userId);
    return { data: { count } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('push-subscribe')
  async pushSubscribe(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = pushSubscribeBodySchema.parse(body);
    await this.notifications.pushSubscribe(userId, {
      endpoint: parsed.endpoint,
      keys: parsed.keys,
      userAgent: parsed.user_agent ?? null,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 30),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('push-test')
  async pushTest(@CurrentUserId() userId: string) {
    const result = await this.notifications.sendTestPush(userId);
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('push-unsubscribe')
  async pushUnsubscribe(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = pushUnsubscribeBodySchema.parse(body);
    await this.notifications.pushUnsubscribe(userId, parsed.endpoint);
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('mark-delivered')
  async markDelivered(@CurrentUserId() userId: string) {
    await this.notifications.markDelivered(userId);
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('mark-read')
  async markReadBySubject(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ) {
    const parsed = markReadBodySchema.parse(body);
    await this.notifications.markReadBySubject(userId, {
      postId: parsed.post_id ?? null,
      userId: parsed.user_id ?? null,
    });
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('mark-all-read')
  async markAllRead(@CurrentUserId() userId: string) {
    await this.notifications.markAllRead(userId);
    return { data: {} };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/mark-read')
  async markReadById(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const updated = await this.notifications.markReadById(userId, id);
    return { data: { updated } };
  }
}
