import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailModule } from '../email/email.module';
import { DailyContentModule } from '../daily-content/daily-content.module';
import { MessagesModule } from '../messages/messages.module';
import { ViewerContextModule } from '../viewer/viewer-context.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCleanupCron } from './notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from './notifications-orphan-cleanup.cron';
import { NotificationsEmailCron } from './notifications-email.cron';
import { NotificationsReplyNudgeCron } from './notifications-reply-nudge.cron';
import { NotificationsService } from './notifications.service';
import { MessagePushEventsHandler } from './message-push-events.handler';
import { MessageInstantEmailEventsHandler } from './message-instant-email-events.handler';

@Module({
  imports: [AuthModule, RealtimeModule, EmailModule, DailyContentModule, MessagesModule, ViewerContextModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MessagePushEventsHandler,
    MessageInstantEmailEventsHandler,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailCron,
    NotificationsReplyNudgeCron,
  ],
  exports: [
    NotificationsService,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailCron,
    NotificationsReplyNudgeCron,
  ],
})
export class NotificationsModule {}
