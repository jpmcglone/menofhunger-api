import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { NotificationsService } from './notifications.service';
import type { NotificationPreferencesDto } from '../../common/dto';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  collapseByRoot: z.coerce.boolean().optional(),
  collapseMode: z.enum(['root', 'parent']).optional(),
  prefer: z.enum(['reply', 'root']).optional(),
  kind: z.enum([
    'comment', 'boost', 'repost', 'follow', 'followed_post',
    'followed_article', 'mention', 'nudge', 'coin_transfer',
    'poll_results_ready', 'generic', 'message',
    'group_join_request',
    'community_group_member_joined',
    'community_group_join_approved',
    'community_group_join_rejected',
    'community_group_member_removed',
    'community_group_disbanded',
    'community_group_invite_received',
    'community_group_invite_accepted',
    'community_group_invite_declined',
    'community_group_invite_cancelled',
    'crew_invite_received',
    'crew_invite_accepted',
    'crew_invite_declined',
    'crew_invite_cancelled',
    'crew_member_joined',
    'crew_member_left',
    'crew_member_kicked',
    'crew_disbanded',
    'crew_owner_transferred',
    'crew_owner_transfer_vote',
    'crew_wall_mention',
  ]).optional(),
});

const markReadBodySchema = z.object({
  post_id: z.string().trim().min(1).optional(),
  user_id: z.string().trim().min(1).optional(),
  article_id: z.string().trim().min(1).optional(),
  crew_id: z.string().trim().min(1).optional(),
  group_id: z.string().trim().min(1).optional(),
}).refine(
  (d) => d.post_id ?? d.user_id ?? d.article_id ?? d.crew_id ?? d.group_id,
  { message: 'At least one of post_id, user_id, article_id, crew_id, or group_id is required' },
);

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

const preferencesPatchSchema = z
  .object({
    pushComment: z.boolean().optional(),
    pushBoost: z.boolean().optional(),
    pushFollow: z.boolean().optional(),
    pushMention: z.boolean().optional(),
    pushMessage: z.boolean().optional(),
    pushRepost: z.boolean().optional(),
    pushNudge: z.boolean().optional(),
    pushFollowedPost: z.boolean().optional(),
    pushReplyNudge: z.boolean().optional(),
    emailDigestDaily: z.boolean().optional(),
    emailDigestWeekly: z.boolean().optional(),
    emailNewNotifications: z.boolean().optional(),
    emailInstantHighSignal: z.boolean().optional(),
    emailFollowedArticle: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one preference is required.' });

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
  @Get('new-posts')
  async listNewPosts(
    @CurrentUserId() userId: string,
    @Query() query: unknown,
  ) {
    const parsed = listQuerySchema.parse(query);
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.notifications.listNewPostsFeed({
      recipientUserId: userId,
      limit,
      cursor,
      collapseByRoot: parsed.collapseByRoot ?? false,
      collapseMode: parsed.collapseMode ?? 'root',
      prefer: parsed.prefer ?? 'reply',
    });
    return {
      data: res.posts,
      pagination: {
        nextCursor: res.nextCursor,
      },
    };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('unread-count')
  async unreadCount(@CurrentUserId() userId: string) {
    const [count, unreadCommentCount] = await Promise.all([
      this.notifications.getUndeliveredCount(userId),
      this.notifications.getUnreadCommentCount(userId),
    ]);
    return { data: { count, unreadCommentCount } };
  }

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
      kind: parsed.kind,
    });
    return {
      data: res.items,
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
  @Get('preferences')
  async preferences(@CurrentUserId() userId: string): Promise<{ data: NotificationPreferencesDto }> {
    return { data: await this.notifications.getPreferences(userId) };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Patch('preferences')
  async updatePreferences(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
  ): Promise<{ data: NotificationPreferencesDto }> {
    const parsed = preferencesPatchSchema.parse(body);
    return { data: await this.notifications.updatePreferences(userId, parsed) };
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
      articleId: parsed.article_id ?? null,
      crewId: parsed.crew_id ?? null,
      groupId: parsed.group_id ?? null,
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

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/ignore')
  async ignoreById(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const updated = await this.notifications.ignoreById(userId, id);
    return { data: { updated } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('nudges/:actorUserId/mark-read')
  async markNudgesReadByActor(
    @CurrentUserId() userId: string,
    @Param('actorUserId') actorUserId: string,
  ) {
    const updatedCount = await this.notifications.markNudgesReadByActor(userId, actorUserId);
    return { data: { updatedCount } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('nudges/:actorUserId/nudged-back')
  async markNudgesNudgedBackByActor(
    @CurrentUserId() userId: string,
    @Param('actorUserId') actorUserId: string,
  ) {
    const updatedCount = await this.notifications.markNudgesNudgedBackByActor(userId, actorUserId);
    return { data: { updatedCount } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':id/nudged-back')
  async markNudgeNudgedBackById(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    const updated = await this.notifications.markNudgeNudgedBackById(userId, id);
    return { data: { updated } };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('nudges/:actorUserId/ignore')
  async ignoreNudgesByActor(
    @CurrentUserId() userId: string,
    @Param('actorUserId') actorUserId: string,
  ) {
    const updatedCount = await this.notifications.ignoreNudgesByActor(userId, actorUserId);
    return { data: { updatedCount } };
  }
}
