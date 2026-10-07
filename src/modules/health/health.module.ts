import { Module } from '@nestjs/common';
import { RuntimeMemoryService } from './runtime-memory.service';
import { HealthController } from './health.controller';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseHealthService } from './database-health.service';
import { AdminGuard } from '../admin/admin.guard';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [HealthController],
  providers: [AdminGuard, RuntimeMemoryService, DatabaseHealthService],
})
export class HealthModule {}

