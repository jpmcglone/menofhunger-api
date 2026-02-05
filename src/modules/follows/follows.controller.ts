import { Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { FollowsService } from './follows.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { setReadCache } from '../../common/http-cache';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

const recommendationsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

@Controller('follows')
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @UseGuards(AuthGuard)
  @Get('me/following-count')
  async myFollowingCount(@CurrentUserId() viewerUserId: string) {
    const followingCount = await this.follows.myFollowingCount({ viewerUserId });
    return { data: followingCount };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('recommendations')
  async recommendations(@CurrentUserId() viewerUserId: string, @Query() query: unknown) {
    const parsed = recommendationsSchema.parse(query);
    const limit = parsed.limit ?? 12;
    const result = await this.follows.recommendUsersToFollow({ viewerUserId, limit });
    return { data: result.users };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post(':username')
  async follow(@Param('username') username: string, @CurrentUserId() viewerUserId: string) {
    const result = await this.follows.follow({ viewerUserId, username });
    return { data: result };
  }

  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Delete(':username')
  async unfollow(@Param('username') username: string, @CurrentUserId() viewerUserId: string) {
    const result = await this.follows.unfollow({ viewerUserId, username });
    return { data: result };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('status/:username')
  async status(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;
    const result = await this.follows.status({ viewerUserId, username });
    setReadCache(httpRes, { viewerUserId });
    return { data: result };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('summary/:username')
  async summary(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;
    const result = await this.follows.summary({ viewerUserId, username });
    setReadCache(httpRes, { viewerUserId });
    return { data: result };
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':username/followers')
  async followers(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = listSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const result = await this.follows.listFollowers({ viewerUserId, username, limit, cursor });
    setReadCache(httpRes, { viewerUserId });
    return { data: result.users, pagination: { nextCursor: result.nextCursor } };
  }

  @UseGuards(OptionalAuthGuard)
  @Get(':username/following')
  async following(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = listSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 30;
    const cursor = parsed.cursor ?? null;
    const result = await this.follows.listFollowing({ viewerUserId, username, limit, cursor });
    setReadCache(httpRes, { viewerUserId });
    return { data: result.users, pagination: { nextCursor: result.nextCursor } };
  }
}

