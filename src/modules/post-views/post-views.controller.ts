import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PostViewsService } from './post-views.service';

const markViewedBatchSchema = z.object({
  postIds: z.array(z.string().trim().min(1)).min(1).max(50),
  anon_id: z.string().trim().min(12).max(128).optional(),
  source: z.string().trim().min(1).max(80).optional(),
});

@Controller()
export class PostViewsController {
  constructor(private readonly postViews: PostViewsService) {}

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
  async markViewed(@OptionalCurrentUserId() userId: string | undefined, @Body() body: unknown) {
    const parsed = markViewedBatchSchema.parse(body);
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
    const result = await this.postViews.getBreakdown(postId, userId ?? null, { fresh: forceFresh });
    return { data: result };
  }
}
