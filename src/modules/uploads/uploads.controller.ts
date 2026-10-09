import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth-public-api';
import { CurrentUserId } from '../users/users.decorator';
import { UploadsService } from './uploads.service';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import {
  initAvatarSchema,
  commitAvatarSchema,
  initBannerSchema,
  commitBannerSchema,
  initPostMediaSchema,
  commitPostMediaSchema,
} from './uploads.schemas';

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
  @Delete('avatar')
  async deleteAvatar(@CurrentUserId() userId: string) {
    const result = await this.uploads.deleteAvatarForUser(userId);
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
  @Delete('banner')
  async deleteBanner(@CurrentUserId() userId: string) {
    const result = await this.uploads.deleteBannerForUser(userId);
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

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('article-thumbnail/init')
  async initArticleThumbnail(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { contentType } = z.object({ contentType: z.string().min(1) }).parse(body);
    const result = await this.uploads.initArticleThumbnailUpload(userId, contentType);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('article-thumbnail/commit')
  async commitArticleThumbnail(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { key } = z.object({ key: z.string().min(1) }).parse(body);
    const result = await this.uploads.commitArticleThumbnailUpload(userId, key);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('article-media/init')
  async initArticleMedia(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { contentType } = z.object({ contentType: z.string().min(1) }).parse(body);
    const result = await this.uploads.initArticleMediaUpload(userId, contentType);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('article-media/commit')
  async commitArticleMedia(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { key } = z.object({ key: z.string().min(1) }).parse(body);
    const result = await this.uploads.commitArticleMediaUpload(userId, key);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('announcement-image/init')
  async initAnnouncementImage(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { contentType } = z.object({ contentType: z.string().min(1) }).parse(body);
    const result = await this.uploads.initAnnouncementImageUpload(userId, contentType);
    return { data: result };
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('upload', 60),
      ttl: rateLimitTtl('upload', 60),
    },
  })
  @Post('announcement-image/commit')
  async commitAnnouncementImage(@Body() body: unknown, @CurrentUserId() userId: string) {
    const { key } = z.object({ key: z.string().min(1) }).parse(body);
    const result = await this.uploads.commitAnnouncementImageUpload(userId, key);
    return { data: result };
  }
}

