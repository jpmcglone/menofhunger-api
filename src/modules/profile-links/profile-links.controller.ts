import { Body, Controller, Get, Param, Patch, Put, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { setReadCache } from '../../common/http-cache';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import type { LinksPageDto, MyProfileLinksDto } from '../../common/dto/profile-links.dto';
import { AuthGuard } from '../auth/auth-public-api';
import { OptionalAuthGuard } from '../auth/auth-public-api';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { ProfileLinksWriteService } from '../users/profile-links-write.service';
import { LinksPageService } from './links-page.service';

const ANON_CACHE_SECONDS = 60;

const publicReadThrottle = {
  default: { limit: rateLimitLimit('publicRead', 300), ttl: rateLimitTtl('publicRead', 60) },
};
const meReadThrottle = {
  default: { limit: rateLimitLimit('read', 120), ttl: rateLimitTtl('read', 60) },
};
const writeThrottle = {
  default: { limit: rateLimitLimit('interact', 30), ttl: rateLimitTtl('interact', 60) },
};

/** `me/links` routes must stay declared before `:username/links`. */
@ApiTags('Profiles & Social')
@Controller('users')
export class ProfileLinksController {
  constructor(
    private readonly linksPage: LinksPageService,
    private readonly linksWrite: ProfileLinksWriteService,
    private readonly cache: CacheService,
  ) {}

  @UseGuards(AuthGuard)
  @Throttle(meReadThrottle)
  @Get('me/links')
  async getMine(@CurrentUserId() userId: string): Promise<{ data: MyProfileLinksDto }> {
    return { data: await this.linksPage.getMine(userId) };
  }

  @UseGuards(AuthGuard)
  @Throttle(writeThrottle)
  @Put('me/links')
  async replaceMine(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: MyProfileLinksDto }> {
    await this.linksWrite.replaceLinks(userId, body);
    return { data: await this.linksPage.getMine(userId) };
  }

  @UseGuards(AuthGuard)
  @Throttle(writeThrottle)
  @Patch('me/links/settings')
  async updateSettings(@CurrentUserId() userId: string, @Body() body: unknown): Promise<{ data: MyProfileLinksDto }> {
    return { data: await this.linksPage.updateSettings(userId, body) };
  }

  @UseGuards(OptionalAuthGuard)
  @Throttle(publicReadThrottle)
  @Get(':username/links')
  async getPage(
    @OptionalCurrentUserId() userId: string | undefined,
    @Param('username') username: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: LinksPageDto }> {
    const viewerUserId = userId ?? null;
    const out = await this.cache.getOrSetJson<{ data: LinksPageDto }>({
      enabled: viewerUserId == null,
      key: RedisKeys.linksPage(username),
      ttlSeconds: ANON_CACHE_SECONDS,
      compute: async () => ({ data: await this.linksPage.getPage(username, viewerUserId) }),
    });
    setReadCache(res, {
      viewerUserId,
      publicMaxAgeSeconds: ANON_CACHE_SECONDS,
      publicStaleWhileRevalidateSeconds: 300,
    });
    return out;
  }
}
