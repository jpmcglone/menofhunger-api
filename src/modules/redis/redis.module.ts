import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { RedisService } from './redis.service';
import { CacheInvalidationService } from './cache-invalidation.service';
import { CacheService } from './cache.service';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [RedisService, CacheInvalidationService, CacheService],
  exports: [RedisService, CacheInvalidationService, CacheService],
})
export class RedisModule {}

