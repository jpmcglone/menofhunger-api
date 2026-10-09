import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { getSessionCookie } from '../../common/session-cookie';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PostViewsBatchService } from './post-views-batch.service';
import { markViewedBatchSchema } from './post-views.schemas';

@Controller()
export class PostViewsController {
  constructor(private readonly postViews: PostViewsBatchService) {}

  /**
   * Batch-mark posts as viewed. Returns whether each id counted as unique and/or total.
   * Old clients that ignore the body still work.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('posts/views')
  @HttpCode(HttpStatus.OK)
  async markViewed(@OptionalCurrentUserId() userId: string | undefined, @Body() body: unknown, @Req() req: Request) {
    const parsed = markViewedBatchSchema.parse(body);
    // An expired/missing session must never turn a signed-in view into a guest.
    if (!userId && (parsed.require_auth || getSessionCookie(req))) {
      throw new UnauthorizedException();
    }
    const data = await this.postViews.markViewedBatch(
      userId ?? null,
      parsed.postIds,
      parsed.anon_id ?? null,
      parsed.source ?? null,
    );
    return { data };
  }

  /**
   * Get the viewer breakdown for a post (premium / verified / unverified).
   * Cached for 60 seconds; invalidated on new unique view.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('posts/:id/views/breakdown')
  async getBreakdown(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') postId: string,
    @Query('fresh') fresh: string | undefined,
  ) {
    const forceFresh = fresh === '1' || fresh === 'true';
    const result = await this.postViews.getBreakdown(postId, userId ?? null, {
      fresh: forceFresh,
    });
    return { data: result };
  }
}
