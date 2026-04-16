import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Param, Post, UseGuards } from '@nestjs/common';
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
  private readonly logger = new Logger(ArticleViewsController.name);

  constructor(private readonly articleViews: ArticleViewsService) {}

  /**
   * Batch-mark articles as viewed by the authenticated user.
   * Idempotent: safe to call multiple times for the same articles.
   * Returns 204 No Content — fire-and-forget friendly.
   */
  @UseGuards(OptionalAuthGuard)
  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 120),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Post('articles/views')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markViewed(@OptionalCurrentUserId() userId: string | undefined, @Body() body: unknown): Promise<void> {
    const parsed = markViewedBatchSchema.parse(body);
    void this.articleViews
      .markViewedBatch(
        userId ?? null,
        parsed.articleIds,
        parsed.anon_id ?? null,
        parsed.source ?? null,
      )
      .catch((err: unknown) => {
        this.logger.warn(`markViewedBatch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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
  async getBreakdown(@OptionalCurrentUserId() userId: string | undefined, @Param('id') articleId: string) {
    const result = await this.articleViews.getBreakdown(articleId, userId ?? null);
    return { data: result };
  }
}
