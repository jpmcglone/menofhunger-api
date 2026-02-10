import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { EmailModule } from '../email/email.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCleanupCron } from './notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from './notifications-orphan-cleanup.cron';
import { NotificationsEmailCron } from './notifications-email.cron';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, forwardRef(() => PresenceModule), EmailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsCleanupCron, NotificationsOrphanCleanupCron, NotificationsEmailCron],
  exports: [NotificationsService, NotificationsCleanupCron, NotificationsOrphanCleanupCron, NotificationsEmailCron],
})
export class NotificationsModule {}
