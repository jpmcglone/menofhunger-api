import { Controller, Get, NotFoundException, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { rateLimitLimit, rateLimitTtl } from '../../common/throttling/rate-limit.resolver';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
import { Websters1828Service } from './websters1828.service';

@Controller('meta/websters1828')
export class Websters1828Controller {
  constructor(
    private readonly websters: Websters1828Service,
    private readonly realtime: PresenceRealtimeService,
  ) {}

  @Throttle({
    default: {
      limit: rateLimitLimit('publicRead', 60),
      ttl: rateLimitTtl('publicRead', 60),
    },
  })
  @UseGuards(OptionalAuthGuard)
  @Get('wotd')
  async wordOfTheDay(
    @Res({ passthrough: true }) res: Response,
    @OptionalCurrentUserId() userId: string | undefined,
    @Query('includeDefinition') includeDefinition?: string,
  ) {
    const wantDefinition =
      String(includeDefinition ?? '').toLowerCase() === '1' ||
      String(includeDefinition ?? '').toLowerCase() === 'true';
    const data = await this.websters.getWordOfDay({ includeDefinition: wantDefinition, userId });
    // likeCount and viewerHasLiked are dynamic — don't let the browser cache
    // a stale snapshot across sessions.
    res.setHeader('Cache-Control', 'private, no-store');
    return { data };
  }

  @UseGuards(AuthGuard)
  @Post('wotd/like')
  async toggleLike(@CurrentUserId() userId: string) {
    const wotd = await this.websters.getWordOfDay({ includeDefinition: false, userId });
    if (!wotd) throw new NotFoundException('No word of the day is available yet.');
    const result = await this.websters.toggleLike(userId, wotd.word);
    this.realtime.emitWotdLikeUpdated(result.likeCount, userId, result.liked);
    return { data: result };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('wotd/likes/breakdown')
  async getLikeBreakdown() {
    const wotd = await this.websters.getWordOfDay({ includeDefinition: false });
    if (!wotd) return { data: { premium: 0, verified: 0, unverified: 0, total: 0 } };
    const result = await this.websters.getLikeBreakdown(wotd.word);
    return { data: result };
  }
}
