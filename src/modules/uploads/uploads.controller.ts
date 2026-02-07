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

const initPostMediaSchema = z.object({
  contentType: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  purpose: z.enum(['post', 'thumbnail']).optional(),
});

const commitPostMediaSchema = z.object({
  key: z.string().min(1),
  contentHash: z.string().min(1).optional(),
  thumbnailKey: z.string().min(1).optional(),
  width: z.coerce.number().int().min(1).max(20000).optional(),
  height: z.coerce.number().int().min(1).max(20000).optional(),
  durationSeconds: z.coerce.number().int().min(0).max(3600).optional(),
}).superRefine((val, ctx) => {
  const key = (val.key ?? '').trim();
  const isVideo = key.includes('/videos/');
  if (!isVideo) return;

  const width = typeof val.width === 'number' ? val.width : null;
  const height = typeof val.height === 'number' ? val.height : null;
  const durationSeconds = typeof val.durationSeconds === 'number' ? val.durationSeconds : null;

  if (width == null || height == null || durationSeconds == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Video uploads must include width, height, and durationSeconds.',
      path: ['width'],
    });
    return;
  }

  if (durationSeconds > 5 * 60) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Video must be 5 minutes or shorter.',
      path: ['durationSeconds'],
    });
  }
  if (width > 2560 || height > 1440) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Video must be 1440p or smaller.',
      path: ['width'],
    });
  }
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
    const result = await this.uploads.initAvatarUpload(userId, parsed.contentType);
    return { data: result };
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
    const result = await this.uploads.commitAvatarUpload(userId, parsed.key);
    return { data: result };
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
    const result = await this.uploads.initBannerUpload(userId, parsed.contentType);
    return { data: result };
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
    const result = await this.uploads.commitBannerUpload(userId, parsed.key);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('post-media/init')
  async initPostMedia(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = initPostMediaSchema.parse(body);
    const result = await this.uploads.initPostMediaUpload(userId, parsed.contentType, {
      contentHash: parsed.contentHash,
      purpose: parsed.purpose,
    });
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('post-media/commit')
  async commitPostMedia(@Body() body: unknown, @CurrentUserId() userId: string) {
    const parsed = commitPostMediaSchema.parse(body);
    const result = await this.uploads.commitPostMediaUpload(userId, {
      key: parsed.key,
      contentHash: parsed.contentHash,
      thumbnailKey: parsed.thumbnailKey,
      width: parsed.width,
      height: parsed.height,
      durationSeconds: parsed.durationSeconds,
    });
    return { data: result };
  }
}

