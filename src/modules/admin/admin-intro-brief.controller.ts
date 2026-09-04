import { Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from './admin.guard';
import { AdminIntroBriefService } from './admin-intro-brief.service';

@UseGuards(AdminGuard)
@Controller('admin/intros')
export class AdminIntroBriefController {
  constructor(private readonly briefs: AdminIntroBriefService) {}

  @Get('brief')
  async latest(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { data: await this.briefs.latest() };
  }

  @Post('brief')
  async generate(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { data: await this.briefs.generate() };
  }
}
