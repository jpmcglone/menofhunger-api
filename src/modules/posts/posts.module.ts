import { PostsWriteAuthorizationService } from "./posts-write-authorization.service";
import { PostsBoardWritePolicy } from "./posts-board-write.policy";
import { PostsCheckinWriteService } from "./posts-checkin-write.service";
import { PostsQuoteWriteService } from "./posts-quote-write.service";
import { PostsWritePersistenceService } from "./posts-write-persistence.service";
import { PostsProfileController } from "./posts-profile.controller";
import { PostsThreadController } from "./posts-thread.controller";
import { PostsRelatedController } from "./posts-related.controller";
import { PostsPublicationController } from "./posts-publication.controller";
import { PostsEngagementController } from "./posts-engagement.controller";
import { PostsPollController } from "./posts-poll.controller";
import { PostsSharedWriteService } from "./posts-shared-write.service";
import { PostsEngagementEffectsService } from "./posts-engagement-effects.service";
import { PostsCreatedEffectsService } from "./posts-created-effects.service";
import { PostsListQueryService } from "./posts-list-query.service";
import { ConversationsModule } from "./conversations.module";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { PostViewsModule } from "../post-views/post-views.module";
import { CashtagsModule } from "../cashtags/cashtags.module";
import { LinkMetadataModule } from "../link-metadata/link-metadata.module";
import { PickaxModule } from "../pickax/pickax.module";
import { XModule } from "../x/x.module";
import { DraftsController } from "./drafts.controller";
import { PollsService } from "./polls.service";
import { PostsController } from "./posts.controller";
import { PostsPublicRecordService } from "./posts-public-record.service";
import { PostsPollResultsReadyCron } from "./posts-poll-results-ready.cron";
import { PostsPopularScoreCron } from "./posts-popular-score.cron";
import { PostsTopicsBackfillCron } from "./posts-topics-backfill.cron";
import { PostsTopicsClassifyService } from "./posts-topics-classify.service";
import { PostsReplyPromptService } from "./posts-reply-prompt.service";
import { PostPermalinkService } from "./posts-permalink.service";
import { PostsDraftsService } from "./posts-drafts.service";
import { PostsEngagementService } from "./posts-engagement.service";
import { PostsRankingService } from "./posts-ranking.service";
import { PostsViewerEnrichmentService } from "./posts-viewer-enrichment.service";
import { PostsFeedAccessService } from "./posts-feed-access.service";
import { PostsWriteAfterCommitService } from "./posts-write-after-commit.service";
import { PostsFeedComposeService } from "./posts-feed-compose.service";
import { PostsFeedListingsService } from "./posts-feed-listings.service";
import { PostsFeedForYouService } from "./posts-feed-for-you.service";
import { PostsFeedPopularService } from "./posts-feed-popular.service";
import { PostsFeedFeaturedService } from "./posts-feed-featured.service";
import { PostsFeedLookupService } from "./posts-feed-lookup.service";
import { PostsFeedProfileService } from "./posts-feed-profile.service";
import { PostsFeedMediaService } from "./posts-feed-media.service";
import { PostsDiscoverMoreService } from "./posts-discover-more.service";
import { PostsMutationSupportService } from "./posts-mutation-support.service";
import { PostsMutationEditsService } from "./posts-mutation-edits.service";
import { PostsMutationWriteService } from "./posts-mutation-write.service";
import { PostsSideEffectsHandler } from "./posts-side-effects.handler";
import { ScheduledPostsService } from "./scheduled-posts.service";
import { ScheduledPostsController } from "./scheduled-posts.controller";
import { ScheduledPostsUpdateService } from "./scheduled-posts-update.service";
import { ScheduledPostsPublishService } from "./scheduled-posts-publish.service";
import { ScheduledPostsPublishCron } from "./scheduled-posts-publish.cron";

@Module({
  imports: [
    ConversationsModule,
    AuthModule,
    NotificationsModule,
    RealtimeModule,
    PostViewsModule,
    CashtagsModule,
    LinkMetadataModule,
    PickaxModule,
    XModule,
  ],
  // ScheduledPostsController must precede PostsController so the static
  // `/posts/scheduled` routes register before PostsController's `/posts/:id`
  // catch-all (otherwise GET /posts/scheduled resolves as id="scheduled" → 404).
  controllers: [
    ScheduledPostsController,
    PostsProfileController,
    PostsThreadController,
    PostsRelatedController,
    PostsPublicationController,
    PostsEngagementController,
    PostsPollController,
    PostsController,
    DraftsController,
  ],
  providers: [
    PostsWriteAuthorizationService,
    PostsBoardWritePolicy,
    PostsCheckinWriteService,
    PostsQuoteWriteService,
    PostsWritePersistenceService,

    PostPermalinkService,
    ScheduledPostsUpdateService,
    ScheduledPostsPublishService,
    PostsDraftsService,
    PostsEngagementService,
    PostsRankingService,
    PostsViewerEnrichmentService,
    PostsFeedAccessService,
    PostsWriteAfterCommitService,
    PostsSharedWriteService,
    PostsFeedComposeService,
    PostsFeedListingsService,
    PostsFeedForYouService,
    PostsFeedPopularService,
    PostsFeedFeaturedService,
    PostsFeedLookupService,
    PostsFeedProfileService,
    PostsFeedMediaService,
    PostsDiscoverMoreService,
    PostsMutationSupportService,
    PostsMutationEditsService,
    PostsMutationWriteService,
    // Lives in this module (not the worker-only consumers module) so the handler resolves in
    // every process — that's what lets SideEffectsService fall back to running it in-process
    // when Redis is unreachable.
    PostsEngagementEffectsService,
    PostsCreatedEffectsService,
    PostsListQueryService,
    PostsSideEffectsHandler,
    PollsService,
    PostsPublicRecordService,
    PostsPopularScoreCron,
    PostsTopicsBackfillCron,
    PostsTopicsClassifyService,
    PostsReplyPromptService,
    PostsPollResultsReadyCron,
    ScheduledPostsService,
    ScheduledPostsPublishCron,
  ],
  exports: [
    PostsSharedWriteService,
    ScheduledPostsService,
    PostsRankingService,
    PostsDraftsService,
    PostsViewerEnrichmentService,
    PostsFeedListingsService,
    PostsFeedComposeService,
    PostsFeedFeaturedService,
    PostsFeedMediaService,
    PostsFeedLookupService,
    PostsMutationEditsService,
    PostsMutationWriteService,
    PostsPublicRecordService,
    PostsPopularScoreCron,
    PostsTopicsBackfillCron,
    PostsTopicsClassifyService,
    PostsPollResultsReadyCron,
    ScheduledPostsPublishCron,
  ],
})
export class PostsModule {}
