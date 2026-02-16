import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailModule } from '../email/email.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCleanupCron } from './notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from './notifications-orphan-cleanup.cron';
import { NotificationsEmailCron } from './notifications-email.cron';
import { NotificationsService } from './notifications.service';
import { MessagePushEventsHandler } from './message-push-events.handler';

@Module({
  imports: [AuthModule, RealtimeModule, EmailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, MessagePushEventsHandler, NotificationsCleanupCron, NotificationsOrphanCleanupCron, NotificationsEmailCron],
  exports: [NotificationsService, NotificationsCleanupCron, NotificationsOrphanCleanupCron, NotificationsEmailCron],
})
export class NotificationsModule {}
