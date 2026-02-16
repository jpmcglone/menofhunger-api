import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PresenceModule } from '../presence/presence.module';
import { DraftsController } from './drafts.controller';
import { PostsController } from './posts.controller';
import { PostsPollResultsReadyCron } from './posts-poll-results-ready.cron';
import { PostsPopularScoreCron } from './posts-popular-score.cron';
import { PostsTopicsBackfillCron } from './posts-topics-backfill.cron';
import { PostsService } from './posts.service';

@Module({
  imports: [AuthModule, NotificationsModule, PresenceModule],
  controllers: [PostsController, DraftsController],
  providers: [PostsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron],
  exports: [PostsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron],
})
export class PostsModule {}

