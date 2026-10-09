import { BoardModule } from "../board/board.module";
import { DelegationService } from "./delegation/delegation.service";
import { DelegationPolicyService } from "./delegation/delegation-policy.service";
import { DelegationActionsService } from "./delegation/delegation-actions.service";
import { DelegationEvidenceService } from "./delegation/delegation-evidence.service";
import { DelegationRunnerService } from "./delegation/delegation-runner.service";
import { DelegationTriageService } from "./delegation/delegation-triage.service";
import { AdminServicesController } from "./admin-services.controller";
import { AdminServiceStatusService } from "./admin-service-status.service";
import { DelegationCron } from "./delegation/delegation.cron";
import { DelegationController } from "./delegation/delegation.controller";
import { BookmarksModule } from "../bookmarks/bookmarks.module";
import { SpacesModule } from "../spaces/spaces.module";
import { JobsModule } from "../jobs/jobs.module";
import { AdminAvatarVideoController } from "./admin-avatar-video.controller";
import { DelegationSideEffectsHandler } from "./delegation/delegation-side-effects.handler";
import { DelegationReadsService } from "./delegation/delegation-reads.service";
import { XModule } from "../x/x.module";
import { AvatarVideoModule } from "../uploads/avatar-video.module";
import { AdminEngagementService } from "./admin-engagement.service";
import { AdminMaintenanceService } from "./admin-maintenance.service";
import { AdminSiteConfigService } from "./admin-site-config.service";
import { AdminSearchService } from "./admin-search.service";
import { AdminReferralService } from "./admin-referral.service";
import { AdminCrewsService } from "./admin-crews.service";
import { AdminAssistantController } from "./admin-assistant.controller";
import { AdminAssistantService } from "./admin-assistant.service";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PostsModule } from "../posts/posts.module";
import { UsersModule } from "../users/users.module";
import { AdminGuard } from "./admin.guard";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { AdminUserActivityService } from "./admin-user-activity.service";
import { AdminUserOrgsService } from "./admin-user-orgs.service";
import { AdminSiteConfigController } from "./admin-site-config.controller";
import { AdminImageReviewController } from "./admin-image-review.controller";
import { AdminImageReviewService } from "./admin-image-review.service";
import { AdminImageReviewStorageService } from "./admin-image-review-storage.service";
import { AdminImageReferencesService } from "./admin-image-review-references.service";
import { AdminImageReviewSyncService } from "./admin-image-review-sync.service";
import { AdminImageReviewActionsService } from "./admin-image-review-actions.service";
import { AdminSearchController } from "./admin-search.controller";
import { AdminHashtagsService } from "./admin-hashtags.service";
import { FeedbackModule } from "../feedback/feedback.module";
import { AdminFeedbackController } from "./admin-feedback.controller";
import { AdminVerificationController } from "./admin-verification.controller";
import { VerificationModule } from "../verification/verification.module";
import { ReportsModule } from "../reports/reports.module";
import { AdminReportsController } from "./admin-reports.controller";
import { HashtagsModule } from "../hashtags/hashtags.module";
import { CashtagsModule } from "../cashtags/cashtags.module";
import { SearchModule } from "../search/search.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { LinkMetadataModule } from "../link-metadata/link-metadata.module";
import { AdminJobsController } from "./admin-jobs.controller";
import { RealtimeModule } from "../realtime/realtime.module";
import { DailyContentModule } from "../daily-content/daily-content.module";
import { AdminDailyContentController } from "./admin-daily-content.controller";
import { AdminEmailSamplesController } from "./admin-email-samples.controller";
import { EmailModule } from "../email/email.module";
import { AdminDailyDigestCron } from "./admin-digest-email.cron";
import { AdminVerificationSlaCron } from "./admin-verification-sla.cron";
import { AdminNewMemberPostsCron } from "./admin-new-member-posts.cron";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminAnalyticsService } from "./admin-analytics.service";
import { AdminBillingController } from "./admin-billing.controller";
import { AdminReferralController } from "./admin-referral.controller";
import { AdminAffiliateController } from "./admin-affiliate.controller";
import { BillingModule } from "../billing/billing.module";
import { CoinsModule } from "../coins/coins.module";
import { CrewModule } from "../crew/crew.module";
import { AdminCrewsController } from "./admin-crews.controller";
import { AdminImpersonationController } from "./admin-impersonation.controller";
import { AdminPushController } from "./admin-push.controller";
import { UploadsModule } from "../uploads/uploads.module";
import { LandingModule } from "../landing/landing.module";
import { MarvinModule } from "../marvin/marvin.module";
import { AdminAnalyticsBriefService } from "./admin-analytics-brief.service";
import { AdminIntroBriefService } from "./admin-intro-brief.service";
import { AdminIntroBriefCron } from "./admin-intro-brief.cron";
import { AdminIntroBriefController } from "./admin-intro-brief.controller";
import { AnnouncementsModule } from "../announcements/announcements.module";
import { AdminAnnouncementsController } from "./admin-announcements.controller";
import { PagesModule } from "../pages/pages.module";
import { AdminPagesController } from "./admin-pages.controller";
import { NewslettersModule } from "../newsletters/newsletters.module";
import { AdminNewslettersController } from "./admin-newsletters.controller";
import { AdminOperationsController } from "./admin-operations.controller";
import { AdminOperationsService } from "./admin-operations.service";

@Module({
  imports: [
    BoardModule,
    BookmarksModule,
    SpacesModule,
    JobsModule,
    AvatarVideoModule,
    AuthModule,
    PrismaModule,
    RealtimeModule,
    UsersModule,
    FeedbackModule,
    ReportsModule,
    PostsModule,
    VerificationModule,
    HashtagsModule,
    CashtagsModule,
    SearchModule,
    NotificationsModule,
    LinkMetadataModule,
    DailyContentModule,
    EmailModule,
    BillingModule,
    CoinsModule,
    CrewModule,
    UploadsModule,
    LandingModule,
    MarvinModule,
    AnnouncementsModule,
    PagesModule,
    NewslettersModule,
    XModule,
  ],
  controllers: [
    DelegationController,
    AdminAvatarVideoController,
    AdminAssistantController,
    AdminOperationsController,
    AdminServicesController,
    AdminUsersController,
    AdminSiteConfigController,
    AdminImageReviewController,
    AdminSearchController,
    AdminFeedbackController,
    AdminReportsController,
    AdminVerificationController,
    AdminJobsController,
    AdminDailyContentController,
    AdminEmailSamplesController,
    AdminAnalyticsController,
    AdminBillingController,
    AdminReferralController,
    AdminAffiliateController,
    AdminCrewsController,
    AdminImpersonationController,
    AdminPushController,
    AdminAnnouncementsController,
    AdminPagesController,
    AdminNewslettersController,
    AdminIntroBriefController,
  ],
  providers: [
    DelegationSideEffectsHandler,
    DelegationReadsService,
    AdminOperationsService,
    AdminUsersService,
    AdminUserActivityService,
    AdminUserOrgsService,
    AdminAnalyticsService,
    DelegationService,
    DelegationPolicyService,
    DelegationActionsService,
    DelegationEvidenceService,
    DelegationRunnerService,
    DelegationTriageService,
    DelegationCron,
    AdminEngagementService,
    AdminSearchService,
    AdminMaintenanceService,
    AdminSiteConfigService,
    AdminReferralService,
    AdminCrewsService,
    AdminServiceStatusService,
    AdminAssistantService,
    AdminGuard,
    AdminImageReviewStorageService,
    AdminImageReferencesService,
    AdminImageReviewSyncService,
    AdminImageReviewActionsService,
    AdminImageReviewService,
    AdminHashtagsService,
    AdminDailyDigestCron,
    AdminVerificationSlaCron,
    AdminNewMemberPostsCron,
    AdminAnalyticsBriefService,
    AdminIntroBriefService,
    AdminIntroBriefCron,
  ],
  exports: [DelegationRunnerService, AdminDailyDigestCron, AdminIntroBriefCron, AdminImageReviewService],
})
export class AdminModule {}
