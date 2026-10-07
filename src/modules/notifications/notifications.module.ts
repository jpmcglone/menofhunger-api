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
import { OnboardingNudgeEmailCron } from './onboarding-nudge-email.cron';
import { NotificationsReplyNudgeCron } from './notifications-reply-nudge.cron';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationPushService } from './notification-push.service';
import { ApnsPushService } from './apns-push.service';
import { NotificationReadStateService } from './notification-read-state.service';
import { NotificationQueryService } from './notification-query.service';
import { NotificationWriterService } from './notification-writer.service';
import { NotificationWriterSupportService } from './notification-writer-support.service';
import { NotificationWriterCommunityService } from './notification-writer-community.service';
import { NotificationWriterFanoutService } from './notification-writer-fanout.service';
import { MessagePushEventsHandler } from './message-push-events.handler';
import { MessageInstantEmailEventsHandler } from './message-instant-email-events.handler';
import { StatusNotificationEventsHandler } from './status-notification-events.handler';
import { NotificationSideEffectsHandler } from './notification-side-effects.handler';
import { OnThisDayCron } from './on-this-day.cron';

@Module({
  imports: [AuthModule, RealtimeModule, EmailModule, DailyContentModule, MessagesModule, ViewerContextModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationPushService,
    ApnsPushService,
    NotificationReadStateService,
    NotificationQueryService,
    NotificationWriterSupportService,
    NotificationWriterCommunityService,
    NotificationWriterFanoutService,
    NotificationWriterService,
    MessagePushEventsHandler,
    MessageInstantEmailEventsHandler,
    StatusNotificationEventsHandler,
    NotificationSideEffectsHandler,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailCron,
    OnboardingNudgeEmailCron,
    NotificationsReplyNudgeCron,
    OnThisDayCron,
  ],
  exports: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationWriterService,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailCron,
    NotificationsReplyNudgeCron,
    OnThisDayCron,
    NotificationPushService,
    ApnsPushService,
  ],
})
export class NotificationsModule {}
