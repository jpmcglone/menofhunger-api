import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { setReadCache } from '../../common/http-cache';
import { HashtagsService } from './hashtags.service';

const trendingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
});

@UseGuards(OptionalAuthGuard)
@Controller('hashtags')
export class HashtagsController {
  constructor(private readonly hashtags: HashtagsService) {}

  @Get('trending')
  async trending(
    @OptionalCurrentUserId() userId: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const parsed = trendingSchema.parse(query);
    const viewerUserId = userId ?? null;
    const limit = parsed.limit ?? 8;
    const cursor = parsed.cursor ?? null;

    const res = await this.hashtags.trendingHashtags({ viewerUserId, limit, cursor });
    setReadCache(httpRes, {
      viewerUserId,
      publicMaxAgeSeconds: 30,
      publicStaleWhileRevalidateSeconds: 60,
      privateMaxAgeSeconds: 60,
    });
    return { data: res.hashtags, pagination: { nextCursor: res.nextCursor } };
  }
}

