import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { DailyContentService } from '../daily-content/daily-content.service';

const refreshSchema = z.object({
  quote: z.coerce.boolean().optional(),
  websters1828: z.coerce.boolean().optional(),
});

@UseGuards(AdminGuard)
@Controller('admin/daily-content')
export class AdminDailyContentController {
  constructor(private readonly daily: DailyContentService) {}

  @Get('today')
  async today(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { data: await this.daily.getToday() };
  }

  @Post('refresh')
  async refresh(@Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = refreshSchema.parse(body ?? {});
    const data = await this.daily.forceRefreshToday({
      quote: parsed.quote,
      websters1828: parsed.websters1828,
    });
    return { data };
  }
}

