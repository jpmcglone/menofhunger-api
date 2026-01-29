import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../users/users.decorator';
import { UploadsService } from './uploads.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';

const initAvatarSchema = z.object({
  contentType: z.string().min(1),
});

const commitAvatarSchema = z.object({
  key: z.string().min(1),
});

const initBannerSchema = z.object({
  contentType: z.string().min(1),
});

const commitBannerSchema = z.object({
  key: z.string().min(1),
});

@UseGuards(AuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('avatar/init')
  async initAvatar(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = initAvatarSchema.parse(body);
    return await this.uploads.initAvatarUpload(userId, parsed.contentType);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('avatar/commit')
  async commitAvatar(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = commitAvatarSchema.parse(body);
    return await this.uploads.commitAvatarUpload(userId, parsed.key);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('banner/init')
  async initBanner(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = initBannerSchema.parse(body);
    return await this.uploads.initBannerUpload(userId, parsed.contentType);
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('banner/commit')
  async commitBanner(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = commitBannerSchema.parse(body);
    return await this.uploads.commitBannerUpload(userId, parsed.key);
  }
}

