import { BadRequestException, Controller, ForbiddenException, Get, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUserId } from '../users/users.decorator';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { RedisKeys } from '../redis/redis-keys';
import { CacheService } from '../redis/cache.service';
import { CacheTtl } from '../redis/cache-ttl';

const searchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const trendingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

type GiphySearchResponse = {
  data: Array<{
    id: string;
    title?: string;
    images?: Record<
      string,
      Partial<{
        url: string;
        width: string;
        height: string;
        mp4: string;
      }>
    >;
  }>;
};

function mapGiphyItems(json: GiphySearchResponse) {
  const items = (json?.data ?? []).map((g) => {
    const original = g.images?.original ?? {};
    const fixed = g.images?.fixed_width ?? {};
    const url = (original.url ?? fixed.url ?? '').toString().trim();
    const mp4Url = (original.mp4 ?? fixed.mp4 ?? '').toString().trim();
    const wRaw = (original.width ?? fixed.width ?? '').toString().trim();
    const hRaw = (original.height ?? fixed.height ?? '').toString().trim();
    const width = Number(wRaw);
    const height = Number(hRaw);
    return {
      id: (g.id ?? '').toString(),
      title: (g.title ?? '').toString(),
      url,
      mp4Url: mp4Url || null,
      width: Number.isFinite(width) && width > 0 ? Math.floor(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.floor(height) : null,
    };
  });
  return items.filter((i) => Boolean(i.id && i.url));
}

@UseGuards(AuthGuard)
@Controller('giphy')
export class GiphyController {
  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private async assertPremium(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { premium: true, premiumPlus: true },
    });
    if (!user) throw new ForbiddenException('Not allowed.');
    if (!user.premium && !user.premiumPlus) {
      throw new ForbiddenException('Upgrade to premium to use GIF search.');
    }
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('search')
  async search(@CurrentUserId() userId: string, @Query() query: unknown) {
    await this.assertPremium(userId);
    const parsed = searchSchema.parse(query);
    const cacheKey = RedisKeys.giphySearch(parsed.q, parsed.limit ?? 24);
    return await this.cache.getOrSetJson<{ data: ReturnType<typeof mapGiphyItems> }>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.giphySeconds,
      compute: async () => {
    const apiKey = this.cfg.giphyApiKey();
    if (!apiKey) throw new ServiceUnavailableException('Giphy is not configured yet.');

    const endpoint = new URL('https://api.giphy.com/v1/gifs/search');
    endpoint.searchParams.set('api_key', apiKey);
    endpoint.searchParams.set('q', parsed.q);
    endpoint.searchParams.set('limit', String(parsed.limit ?? 24));
    endpoint.searchParams.set('rating', 'pg-13');

    let json: GiphySearchResponse;
    try {
      const res = await fetch(endpoint.toString(), { method: 'GET' });
      if (!res.ok) throw new BadRequestException('Failed to search Giphy.');
      json = (await res.json()) as GiphySearchResponse;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Failed to search Giphy.');
    }

        return { data: mapGiphyItems(json) };
      },
    });
  }

  @Throttle({
    default: {
      limit: rateLimitLimit('interact', 180),
      ttl: rateLimitTtl('interact', 60),
    },
  })
  @Get('trending')
  async trending(@CurrentUserId() userId: string, @Query() query: unknown) {
    await this.assertPremium(userId);
    const parsed = trendingSchema.parse(query);
    const cacheKey = RedisKeys.giphyTrending(parsed.limit ?? 24);
    return await this.cache.getOrSetJson<{ data: ReturnType<typeof mapGiphyItems> }>({
      enabled: true,
      key: cacheKey,
      ttlSeconds: CacheTtl.giphySeconds,
      compute: async () => {
    const apiKey = this.cfg.giphyApiKey();
    if (!apiKey) throw new ServiceUnavailableException('Giphy is not configured yet.');

    const endpoint = new URL('https://api.giphy.com/v1/gifs/trending');
    endpoint.searchParams.set('api_key', apiKey);
    endpoint.searchParams.set('limit', String(parsed.limit ?? 24));
    endpoint.searchParams.set('rating', 'pg-13');

    let json: GiphySearchResponse;
    try {
      const res = await fetch(endpoint.toString(), { method: 'GET' });
      if (!res.ok) throw new BadRequestException('Failed to load trending GIFs.');
      json = (await res.json()) as GiphySearchResponse;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Failed to load trending GIFs.');
    }

        return { data: mapGiphyItems(json) };
      },
    });
  }
}

