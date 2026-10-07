import { AdminAnalyticsService } from './admin-analytics.service';
import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { CurrentUserId } from '../users/users.decorator';
import { AdminAnalyticsBriefService } from './admin-analytics-brief.service';

const briefBodySchema = z.object({
  range: z.enum(['7d', '30d', '3m', '1y', 'all']),
  analytics: z.record(z.string(), z.unknown()),
  referrals: z.record(z.string(), z.unknown()).nullable().optional(),
});

@Controller('admin/analytics')
@UseGuards(AdminGuard)
export class AdminAnalyticsController {
  constructor(
    private readonly analytics: AdminAnalyticsService,
    private readonly briefService: AdminAnalyticsBriefService,
  ) {}

  @Post('brief')
  async brief(@Body() body: unknown, @CurrentUserId() adminUserId?: string) {
    const parsed = briefBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Send the analytics snapshot already on this page.');
    }
    const data = await this.briefService.brief(adminUserId ?? 'admin', {
      range: parsed.data.range,
      analytics: parsed.data.analytics,
      referrals: parsed.data.referrals ?? null,
    });
    return { data };
  }

  @Get()
  async getAnalytics(@Query('range') rangeParam = '30d') {
    return this.analytics.read(rangeParam);
  }
}
