import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../admin/admin.guard';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MetricsController],
  providers: [AdminGuard, MetricsService],
})
export class MetricsModule {}

