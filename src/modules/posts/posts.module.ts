import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { DraftsController } from './drafts.controller';
import { PollsService } from './polls.service';
import { PostsController } from './posts.controller';
import { PostsPollResultsReadyCron } from './posts-poll-results-ready.cron';
import { PostsPopularScoreCron } from './posts-popular-score.cron';
import { PostsTopicsBackfillCron } from './posts-topics-backfill.cron';
import { PostsService } from './posts.service';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule],
  controllers: [PostsController, DraftsController],
  providers: [PostsService, PollsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron],
  exports: [PostsService, PollsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron],
})
export class PostsModule {}

