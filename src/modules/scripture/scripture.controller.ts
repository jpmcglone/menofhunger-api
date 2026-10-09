import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { publicCacheControl } from '../../common/http-cache';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { ScriptureService } from './scripture.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { getSchema } from './scripture.schemas';

@UseGuards(OptionalAuthGuard)
@Controller('scripture')
export class ScriptureController {
  constructor(private readonly scripture: ScriptureService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async get(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const { ref } = getSchema.parse(query);
    const data = await this.scripture.getRef(ref);
    // Verse text is immutable; long cache is appropriate.
    res.setHeader('Cache-Control', publicCacheControl(2592000));
    return { data };
  }
}
