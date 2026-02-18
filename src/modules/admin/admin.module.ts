import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsModule } from '../posts/posts.module';
import { UsersModule } from '../users/users.module';
import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminSiteConfigController } from './admin-site-config.controller';
import { AdminImageReviewController } from './admin-image-review.controller';
import { AdminImageReviewService } from './admin-image-review.service';
import { AdminSearchController } from './admin-search.controller';
import { AdminHashtagsService } from './admin-hashtags.service';
import { FeedbackModule } from '../feedback/feedback.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminVerificationController } from './admin-verification.controller';
import { VerificationModule } from '../verification/verification.module';
import { ReportsModule } from '../reports/reports.module';
import { AdminReportsController } from './admin-reports.controller';
import { HashtagsModule } from '../hashtags/hashtags.module';
import { SearchModule } from '../search/search.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';
import { AdminJobsController } from './admin-jobs.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { DailyContentModule } from '../daily-content/daily-content.module';
import { AdminDailyContentController } from './admin-daily-content.controller';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    RealtimeModule,
    UsersModule,
    FeedbackModule,
    ReportsModule,
    PostsModule,
    VerificationModule,
    HashtagsModule,
    SearchModule,
    NotificationsModule,
    LinkMetadataModule,
    DailyContentModule,
  ],
  controllers: [
    AdminUsersController,
    AdminSiteConfigController,
    AdminImageReviewController,
    AdminSearchController,
    AdminFeedbackController,
    AdminReportsController,
    AdminVerificationController,
    AdminJobsController,
    AdminDailyContentController,
  ],
  providers: [AdminGuard, AdminImageReviewService, AdminHashtagsService],
})
export class AdminModule {}

