import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminGuard } from './admin.guard';
import { AdminUsersController } from './admin-users.controller';
import { AdminSiteConfigController } from './admin-site-config.controller';
import { AdminImageReviewController } from './admin-image-review.controller';
import { AdminImageReviewService } from './admin-image-review.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminUsersController, AdminSiteConfigController, AdminImageReviewController],
  providers: [AdminGuard, AdminImageReviewService],
})
export class AdminModule {}

