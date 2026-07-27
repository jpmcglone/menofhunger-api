import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from './admin.guard';
import { DailyContentService } from '../daily-content/daily-content.service';
import { queryBoolean } from '../../common/validation/query-boolean';

const republishSchema = z.object({
  quote: queryBoolean().optional(),
  websters1828: queryBoolean().optional(),
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
    const parsed = republishSchema.parse(body ?? {});
    const item =
      parsed.websters1828 === true && parsed.quote !== true
        ? 'word'
        : parsed.quote === true && parsed.websters1828 !== true
          ? 'quote'
          : undefined;
    const data = await this.daily.republish({ item });
    return { data };
  }
}
