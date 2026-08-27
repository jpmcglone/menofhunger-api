import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { ArticleViewsService } from './article-views.service';

const markViewedBatchSchema = z.object({
  articleIds: z.array(z.string().trim().min(1)).min(1).max(50),
  anon_id: z.string().trim().min(12).max(128).optional(),
  source: z.string().trim().min(1).max(80).optional(),
});

@Controller()
export class ArticleViewsController {
  constructor(private readonly articleViews: ArticleViewsService) {}

  /**
   * Batch-mark articles as viewed. Returns whether each id counted as unique and/or total.
   * Old clients that ignore the body still work.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('articles/views')
  @HttpCode(HttpStatus.OK)
  async markViewed(@OptionalCurrentUserId() userId: string | undefined, @Body() body: unknown) {
    const parsed = markViewedBatchSchema.parse(body);
    const data = await this.articleViews.markViewedBatch(
      userId ?? null,
      parsed.articleIds,
      parsed.anon_id ?? null,
      parsed.source ?? null,
    );
    return { data };
  }

  /**
   * Get the viewer breakdown for an article (premium / verified / unverified).
   * Cached for 60 seconds; invalidated on new unique view.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('read', 120),
      ttl: rateLimitTtl('read', 60),
    },
  })
  @Get('articles/:id/views/breakdown')
  async getBreakdown(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('id') articleId: string,
    @Query('fresh') fresh: string | undefined,
  ) {
    const forceFresh = fresh === '1' || fresh === 'true';
    const result = await this.articleViews.getBreakdown(articleId, userId ?? null, { fresh: forceFresh });
    return { data: result };
  }
}
