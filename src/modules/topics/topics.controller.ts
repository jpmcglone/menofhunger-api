import { Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';
import { TopicsService } from './topics.service';
import { TOPIC_OPTIONS } from '../../common/topics/topic-options';

const listTopicsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const listTopicPostsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const listFollowedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

@UseGuards(OptionalAuthGuard)
@Controller('topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('options')
  async options(@OptionalCurrentUserId() userId: string | undefined, @Res({ passthrough: true }) httpRes: Response) {
    const viewerUserId = userId ?? null;
    setReadCache(httpRes, { viewerUserId });
    return { data: TOPIC_OPTIONS.map((t) => ({ value: t.value, label: t.label, group: t.group })) };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async list(@OptionalCurrentUserId() userId: string | undefined, @Query() query: unknown, @Res({ passthrough: true }) httpRes: Response) {
    const parsed = listTopicsSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const data = await this.topics.listTopics({ viewerUserId, limit });
    setReadCache(httpRes, { viewerUserId });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('followed')
  async followed(@CurrentUserId() userId: string, @Query() query: unknown) {
    const parsed = listFollowedSchema.parse(query);
    const limit = parsed.limit ?? 50;
    const data = await this.topics.listFollowedTopics({ viewerUserId: userId, limit });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':topic/follow')
  async follow(@Param('topic') topic: string, @CurrentUserId() userId: string) {
    const data = await this.topics.followTopic({ userId, topic });
    return { data };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':topic/follow')
  async unfollow(@Param('topic') topic: string, @CurrentUserId() userId: string) {
    const data = await this.topics.unfollowTopic({ userId, topic });
    return { data };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 240),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get(':topic/posts')
  async posts(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('topic') topic: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = listTopicPostsSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const res = await this.topics.listTopicPosts({ viewerUserId, topic, limit, cursor });
    setReadCache(httpRes, { viewerUserId });
    return { data: res.posts, pagination: { nextCursor: res.nextCursor } };
  }
}

