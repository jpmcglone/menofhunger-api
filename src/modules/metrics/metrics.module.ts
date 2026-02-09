import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [PrismaModule],
  controllers: [MetricsController],
})
export class MetricsModule {}

