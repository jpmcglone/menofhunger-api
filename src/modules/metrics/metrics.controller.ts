import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { MetricsService } from './metrics.service';

@UseGuards(AdminGuard)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('active-users')
  async getActiveUsers() {
    return { data: await this.metrics.getActiveUsers() };
  }
}
