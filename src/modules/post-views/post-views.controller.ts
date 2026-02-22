import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { PostViewsService } from './post-views.service';

const markViewedBatchSchema = z.object({
  postIds: z.array(z.string().trim().min(1)).min(1).max(50),
});

@Controller()
export class PostViewsController {
  constructor(private readonly postViews: PostViewsService) {}

  /**
   * Batch-mark posts as viewed by the authenticated user.
   * Idempotent: safe to call multiple times for the same posts.
   * Returns 204 No Content — fire-and-forget friendly.
   */
  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('posts/views')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markViewed(@CurrentUserId() userId: string, @Body() body: unknown): Promise<void> {
    const parsed = markViewedBatchSchema.parse(body);
    await this.postViews.markViewedBatch(userId, parsed.postIds);
  }

  /**
   * Get the viewer breakdown for a post (premium / verified / unverified).
   * Cached for 60 seconds; invalidated on new unique view.
   */
  @UseGuards(AuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('posts/:id/views/breakdown')
  async getBreakdown(@CurrentUserId() userId: string, @Param('id') postId: string) {
    void userId; // auth guard ensures user is logged in; breakdown itself is not viewer-specific
    const result = await this.postViews.getBreakdown(postId);
    return { data: result };
  }
}
