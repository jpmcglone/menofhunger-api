import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PostsModule } from '../posts/posts.module';
import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminSiteConfigController } from './admin-site-config.controller';
import { AdminImageReviewController } from './admin-image-review.controller';
import { AdminImageReviewService } from './admin-image-review.service';
import { AdminSearchController } from './admin-search.controller';
import { FeedbackModule } from '../feedback/feedback.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminVerificationController } from './admin-verification.controller';
import { VerificationModule } from '../verification/verification.module';

@Module({
  imports: [AuthModule, PrismaModule, FeedbackModule, PostsModule, VerificationModule],
  controllers: [
    AdminUsersController,
    AdminSiteConfigController,
    AdminImageReviewController,
    AdminSearchController,
    AdminFeedbackController,
    AdminVerificationController,
  ],
  providers: [AdminGuard, AdminImageReviewService],
})
export class AdminModule {}

