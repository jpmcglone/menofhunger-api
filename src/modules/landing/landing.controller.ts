import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LandingService } from './landing.service';

@Controller('meta/landing')
export class LandingController {
  constructor(private readonly landing: LandingService) {}

  @Get()
  async snapshot(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    const data = await this.landing.getSnapshot();
    return { data };
  }
}
