import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
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
   * Batch-mark posts as viewed by the authenticated user.
   * Idempotent: safe to call multiple times for the same posts.
   * Returns 204 No Content — fire-and-forget friendly.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('posts/views')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markViewed(@OptionalCurrentUserId() userId: string | undefined, @Body() body: unknown): Promise<void> {
    const parsed = markViewedBatchSchema.parse(body);
    void this.postViews
      .markViewedBatch(userId ?? null, parsed.postIds, parsed.anon_id ?? null, parsed.source ?? null)
      .catch(() => undefined);
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
  async getBreakdown(@OptionalCurrentUserId() userId: string | undefined, @Param('id') postId: string) {
    const result = await this.postViews.getBreakdown(postId, userId ?? null);
    return { data: result };
  }
}
