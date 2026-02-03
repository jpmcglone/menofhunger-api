import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
  async get(@Query() query: unknown) {
    const parsed = getSchema.parse(query);
    const meta = await this.linkMetadata.getMetadata(parsed.url);
    return { data: meta };
  }
}
