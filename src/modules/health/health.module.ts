import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from '../admin/admin.guard';

@Module({
  imports: [RedisModule, AuthModule],
  controllers: [HealthController],
  providers: [AdminGuard],
})
export class HealthModule {}

