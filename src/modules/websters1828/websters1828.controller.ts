import { Controller, Get, Res } from '@nestjs/common';
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
  async wordOfTheDay(@Res({ passthrough: true }) res: Response) {
    const data = await this.websters.getWordOfDay();
    const maxAge = this.websters.getCacheControlMaxAgeSeconds(new Date());
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    return { data };
  }
}

