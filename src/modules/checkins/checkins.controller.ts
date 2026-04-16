import { Body, Controller, Get, Post, UseGuards, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId, OptionalCurrentUserId } from '../users/users.decorator';
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

@Controller('checkins')
export class CheckinsController {
  constructor(
    private readonly checkins: CheckinsService,
    private readonly appConfig: AppConfigService,
  ) {}

  @UseGuards(OptionalAuthGuard)
  @Get('leaderboard')
  async getLeaderboard(
    @OptionalCurrentUserId() viewerUserId: string | undefined,
    @Query() query: unknown,
  ) {
    const { limit, scope } = leaderboardQuerySchema.parse(query);
    const publicBaseUrl = this.appConfig.r2()?.publicBaseUrl ?? null;

    if (scope === 'weekly') {
      const { users, viewerRank, weekStart } = await this.checkins.getWeeklyLeaderboard({
        publicBaseUrl,
        limit,
        viewerUserId: viewerUserId ?? null,
      });
      return { data: { users, viewerRank: viewerRank ?? null, weekStart: weekStart.toISOString(), generatedAt: new Date().toISOString() } };
    }

    if (scope === 'best') {
      const { users, viewerRank } = await this.checkins.getBestStreakLeaderboard({
        publicBaseUrl,
        limit,
        viewerUserId: viewerUserId ?? null,
      });
      return { data: { users, viewerRank: viewerRank ?? null, generatedAt: new Date().toISOString() } };
    }

    const { users, viewerRank } = await this.checkins.getLeaderboard({
      publicBaseUrl,
      limit,
      viewerUserId: viewerUserId ?? null,
    });
    return { data: { users, viewerRank: viewerRank ?? null, generatedAt: new Date().toISOString() } };
  }

  @UseGuards(AuthGuard)
  @Get('today')
  async getToday(@CurrentUserId() userId: string) {
    const data = await this.checkins.getTodayState({ userId });
    return { data };
  }

  @UseGuards(AuthGuard)
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

