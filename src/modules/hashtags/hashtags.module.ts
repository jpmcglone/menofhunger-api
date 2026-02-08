import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HashtagsController } from './hashtags.controller';
import { HashtagsTrendingScoreCron } from './hashtags-trending-score.cron';
import { HashtagsService } from './hashtags.service';

@Module({
  imports: [AuthModule],
  controllers: [HashtagsController],
  providers: [HashtagsService, HashtagsTrendingScoreCron],
  exports: [HashtagsService],
})
export class HashtagsModule {}

