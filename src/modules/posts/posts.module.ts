import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PostViewsModule } from '../post-views/post-views.module';
import { CashtagsModule } from '../cashtags/cashtags.module';
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
import { ScheduledPostsService } from './scheduled-posts.service';
import { ScheduledPostsController } from './scheduled-posts.controller';
import { ScheduledPostsPublishCron } from './scheduled-posts-publish.cron';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule, PostViewsModule, CashtagsModule],
  // ScheduledPostsController must precede PostsController so the static
  // `/posts/scheduled` routes register before PostsController's `/posts/:id`
  // catch-all (otherwise GET /posts/scheduled resolves as id="scheduled" → 404).
  controllers: [ScheduledPostsController, PostsController, DraftsController],
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
    ScheduledPostsService,
    ScheduledPostsPublishCron,
  ],
  exports: [PostsService, PollsService, PostsPopularScoreCron, PostsTopicsBackfillCron, PostsPollResultsReadyCron, ScheduledPostsPublishCron],
})
export class PostsModule {}

