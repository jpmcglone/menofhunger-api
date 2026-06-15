import { Body, Controller, Get, Header, Post, UseGuards, Query } from '@nestjs/common';
import { z } from 'zod';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { VerifiedGuard } from '../auth/verified.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId } from '../users/users.decorator';
import { toPostDto } from '../posts/post.dto';
import { CheckinsService } from './checkins.service';

const createSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  visibility: z.enum(['verifiedOnly', 'premiumOnly']),
});

const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  scope: z.enum(['weekly', 'best']).optional(),
});

@ApiTags('Check-ins & Streaks')
@Controller('checkins')
// The entire check-ins experience (feed, streaks, leaderboard, social proof) is
// verified-only. Unverified/anonymous users are locked out at the API boundary;
// the web/iOS clients render a "Verify to check in" CTA instead of calling these.
@UseGuards(AuthGuard, VerifiedGuard)
export class CheckinsController {
  constructor(
    private readonly checkins: CheckinsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get('leaderboard')
  async getLeaderboard(
    @CurrentUserId() viewerUserId: string,
    @Query() query: unknown,
  ) {
    const { limit, scope } = leaderboardQuerySchema.parse(query);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    if (scope === 'weekly') {
      const { users, viewerRank, weekStart } = await this.checkins.getWeeklyLeaderboard({
        publicBaseUrl,
        limit,
        viewerUserId,
      });
      return { data: { users, viewerRank: viewerRank ?? null, weekStart: weekStart.toISOString(), generatedAt: new Date().toISOString() } };
    }

    if (scope === 'best') {
      const { users, viewerRank } = await this.checkins.getBestStreakLeaderboard({
        publicBaseUrl,
        limit,
        viewerUserId,
      });
      return { data: { users, viewerRank: viewerRank ?? null, generatedAt: new Date().toISOString() } };
    }

    const { users, viewerRank } = await this.checkins.getLeaderboard({
      publicBaseUrl,
      limit,
      viewerUserId,
    });
    return { data: { users, viewerRank: viewerRank ?? null, generatedAt: new Date().toISOString() } };
  }

  @Get('today')
  async getToday(@CurrentUserId() userId: string) {
    const data = await this.checkins.getTodayState({
      userId,
      publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
    });
    return { data };
  }

  @Get('today/answered')
  @Header('Cache-Control', 'private, max-age=30')
  async getTodayAnswered(@CurrentUserId() viewerUserId: string) {
    const data = await this.checkins.getTodayAnswered({
      viewerUserId,
      publicBaseUrl: this.appConfig.r2()?.publicBaseUrl ?? null,
    });
    return { data };
  }

  @Post()
  async create(@CurrentUserId() userId: string, @Body() body: unknown) {
    const parsed = createSchema.parse(body);
    const res = await this.checkins.createTodayCheckin({
      userId,
      body: parsed.body,
      visibility: parsed.visibility,
    });
    return {
      data: {
        ...res,
        post: toPostDto(res.post as any, this.appConfig.r2()?.publicBaseUrl ?? null),
      },
    };
  }
}

