import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}

