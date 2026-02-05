import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { LinkMetadataService } from './link-metadata.service';
import { Throttle } from '@nestjs/throttler';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const getSchema = z.object({
  url: z.string().trim().url(),
});

@UseGuards(OptionalAuthGuard)
@Controller('link-metadata')
export class LinkMetadataController {
  constructor(private readonly linkMetadata: LinkMetadataService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 120),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @Get()
  async get(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = getSchema.parse(query);
    const meta = await this.linkMetadata.getMetadata(parsed.url);
    // Response is already DB-cached; allow long edge/browser caching.
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return { data: meta };
  }
}
