import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { HashtagsController } from './hashtags.controller';
import { HashtagsCleanupCron } from './hashtags-cleanup.cron';
import { HashtagsTrendingScoreCron } from './hashtags-trending-score.cron';
import { HashtagsService } from './hashtags.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [HashtagsController],
  providers: [HashtagsService, HashtagsTrendingScoreCron, HashtagsCleanupCron],
  exports: [HashtagsService, HashtagsTrendingScoreCron, HashtagsCleanupCron],
})
export class HashtagsModule {}

