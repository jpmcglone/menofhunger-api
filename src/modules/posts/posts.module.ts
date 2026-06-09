import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PostViewsModule } from '../post-views/post-views.module';
import { DraftsController } from './drafts.controller';
import { PollsService } from './polls.service';
import { PostsController } from './posts.controller';
import { PostsPollResultsReadyCron } from './posts-poll-results-ready.cron';
import { PostsPopularScoreCron } from './posts-popular-score.cron';
import { PostsTopicsBackfillCron } from './posts-topics-backfill.cron';
import { PostsService } from './posts.service';
import { PostsDraftsService } from './posts-drafts.service';
import { PostsEngagementService } from './posts-engagement.service';
import { PostsRankingService } from './posts-ranking.service';
import { PostsViewerEnrichmentService } from './posts-viewer-enrichment.service';
import { PostsFeedQueryService } from './posts-feed-query.service';
import { PostsMutationService } from './posts-mutation.service';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule, PostViewsModule],
  controllers: [PostsController, DraftsController],
  providers: [
    PostsService,
    PostsDraftsService,
    PostsEngagementService,
    PostsRankingService,
    PostsViewerEnrichmentService,
    PostsFeedQueryService,
    PostsMutationService,
    PollsService,
    PostsPopularScoreCron,
    PostsTopicsBackfillCron,
    PostsPollResultsReadyCron,
  ],
  exports: [PostsService, PollsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron],
})
export class PostsModule {}

