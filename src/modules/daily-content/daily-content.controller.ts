import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DailyContentService } from './daily-content.service';

@Controller('meta/daily-content')
export class DailyContentController {
  constructor(private readonly daily: DailyContentService) {}

  @Get('today')
  async today(@Res({ passthrough: true }) res: Response) {
    const data = await this.daily.getToday();
    // A publish can finish after its scheduled boundary or be corrected by an admin.
    // Never cache a missing/old snapshot while notifications announce the new one.
    res.setHeader('Cache-Control', 'private, no-store');
    return { data };
  }
}

