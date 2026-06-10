import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { OptionalCurrentUserId } from '../users/users.decorator';
import { ExploreService } from './explore.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CacheTtl } from '../redis/cache-ttl';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

@UseGuards(OptionalAuthGuard)
@Controller('explore')
export class ExploreController {
  constructor(
    private readonly explore: ExploreService,
    private readonly cache: CacheService,
    private readonly cacheInvalidation: CacheInvalidationService,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async aggregate(
    @OptionalCurrentUserId() userId: string | undefined,
    @Res({ passthrough: true }) httpRes: Response,
  ) {
    const viewerUserId = userId ?? null;

    httpRes.setHeader(
      'Cache-Control',
      viewerUserId ? 'private, max-age=30' : 'public, max-age=30, stale-while-revalidate=60',
    );
    httpRes.setHeader('Vary', 'Cookie');

    // Cache the anonymous aggregate for ~30-60s using the feed version as a
    // cache-busting key. Authed responses are per-user and never cached server-side.
    if (!viewerUserId) {
      const feedVer = await this.cacheInvalidation.feedGlobalVersion();
      const cacheKey = RedisKeys.anonExplore(feedVer);
      const cached = await this.cache.getOrSetJson<{ data: unknown }>({
        enabled: true,
        key: cacheKey,
        ttlSeconds: CacheTtl.anonFeedSeconds,
        compute: async () => {
          const data = await this.explore.aggregate({ viewerUserId: null });
          return { data };
        },
      });
      return cached;
    }

    const data = await this.explore.aggregate({ viewerUserId });
    return { data };
  }
}
