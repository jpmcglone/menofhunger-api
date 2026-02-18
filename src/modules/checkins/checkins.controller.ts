import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AppConfigService } from '../app/app-config.service';
import { CurrentUserId } from '../users/users.decorator';
import { toPostDto } from '../posts/post.dto';
import { CheckinsService } from './checkins.service';

const createSchema = z.object({
  body: z.string().trim().min(1).max(1000),
  visibility: z.enum(['verifiedOnly', 'premiumOnly']),
});

@Controller('checkins')
export class CheckinsController {
  constructor(
    private readonly checkins: CheckinsService,
    private readonly appConfig: AppConfigService,
  ) {}

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

