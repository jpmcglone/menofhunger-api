import { Controller, Get, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { Websters1828Service } from './websters1828.service';

@Controller('meta/websters1828')
export class Websters1828Controller {
  constructor(private readonly websters: Websters1828Service) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 60),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get('wotd')
  async wordOfTheDay(
    @Res({ passthrough: true }) res: Response,
    @Query('includeDefinition') includeDefinition?: string,
  ) {
    const wantDefinition =
      String(includeDefinition ?? '').toLowerCase() === '1' ||
      String(includeDefinition ?? '').toLowerCase() === 'true';
    const data = await this.websters.getWordOfDay({ includeDefinition: wantDefinition });
    const maxAge = this.websters.getCacheControlMaxAgeSeconds(new Date());
    // IMPORTANT: keep this out of shared/CDN caches so querystring variants can't get mixed.
    res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
    return { data };
  }
}

