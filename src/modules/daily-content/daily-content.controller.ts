import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DailyContentService } from './daily-content.service';

@Controller('meta/daily-content')
export class DailyContentController {
  constructor(private readonly daily: DailyContentService) {}

  @Get('today')
  async today(@Res({ passthrough: true }) res: Response) {
    const data = await this.daily.getToday();
    const maxAge = this.daily.getCacheControlMaxAgeSeconds(new Date());
    res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
    return { data };
  }
}

