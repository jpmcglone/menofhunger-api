import { Global, Module } from '@nestjs/common';
import { RequestCacheService } from './request-cache.service';

@Global()
@Module({
  providers: [RequestCacheService],
  exports: [RequestCacheService],
})
export class RequestCacheModule {}

