import { NotificationNudgesService } from "./notification-nudges.service";
import { NotificationReadSubjectsService } from "./notification-read-subjects.service";
import { NotificationFanoutContentService } from "./notification-fanout-content.service";
import { NotificationEngagementWriterService } from "./notification-engagement-writer.service";
import { NotificationInviteWriterService } from "./notification-invite-writer.service";
import { NotificationQueryListService } from "./notification-query-list.service";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { EmailModule } from "../email/email.module";
import { DailyContentModule } from "../daily-content/daily-content.module";
import { MessagesModule } from "../messages/messages.module";
import { ViewerContextModule } from "../viewer/viewer-context.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsCleanupCron } from "./notifications-cleanup.cron";
import { NotificationsOrphanCleanupCron } from "./notifications-orphan-cleanup.cron";
import { NotificationsEmailCron } from "./notifications-email.cron";
import { NotificationsEmailSupportService } from "./notifications-email-support.service";
import { NotificationsEmailWeeklyService } from "./notifications-email-weekly.service";
import { OnboardingNudgeEmailCron } from "./onboarding-nudge-email.cron";
import { NotificationsReplyNudgeCron } from "./notifications-reply-nudge.cron";

import { NotificationPreferencesService } from "./notification-preferences.service";
import { NotificationPushDeliveryService } from "./notification-push-delivery.service";
import { NotificationPushKindService } from "./notification-push-kind.service";
import { NotificationPushService } from "./notification-push.service";
import { ApnsPushService } from "./apns-push.service";
import { NotificationReadStateService } from "./notification-read-state.service";
import { NotificationQueryService } from "./notification-query.service";
import { NotificationCreatorService } from "./notification-creator.service";
import { NotificationCleanupService } from "./notification-cleanup.service";
import { NotificationFollowPolicyService } from "./notification-follow-policy.service";
import { NotificationMarvWriterService } from "./notification-marv-writer.service";
import { NotificationWriterSupportService } from "./notification-writer-support.service";
import { NotificationWriterCommunityService } from "./notification-writer-community.service";
import { NotificationWriterFanoutService } from "./notification-writer-fanout.service";
import { MessagePushEventsHandler } from "./message-push-events.handler";
import { MessageInstantEmailEventsHandler } from "./message-instant-email-events.handler";
import { StatusNotificationEventsHandler } from "./status-notification-events.handler";
import { NotificationSideEffectsHandler } from "./notification-side-effects.handler";
import { OnThisDayCron } from "./on-this-day.cron";

@Module({
  imports: [
    AuthModule,
    RealtimeModule,
    EmailModule,
    DailyContentModule,
    MessagesModule,
    ViewerContextModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationPreferencesService,
    NotificationPushDeliveryService,
    NotificationPushKindService,
    NotificationPushService,
    ApnsPushService,
    NotificationReadStateService,
    NotificationQueryService,
    NotificationWriterSupportService,
    NotificationWriterCommunityService,
    NotificationFanoutContentService,
    NotificationEngagementWriterService,
    NotificationInviteWriterService,
    NotificationQueryListService,
    NotificationWriterFanoutService,
    NotificationNudgesService,
    NotificationReadSubjectsService,
    NotificationCreatorService,
    NotificationCleanupService,
    NotificationFollowPolicyService,
    NotificationMarvWriterService,
    MessagePushEventsHandler,
    MessageInstantEmailEventsHandler,
    StatusNotificationEventsHandler,
    NotificationSideEffectsHandler,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailSupportService,
    NotificationsEmailWeeklyService,
    NotificationsEmailCron,
    OnboardingNudgeEmailCron,
    NotificationsReplyNudgeCron,
    OnThisDayCron,
  ],
  exports: [
    NotificationCreatorService,
    NotificationEngagementWriterService,
    NotificationInviteWriterService,
    NotificationWriterCommunityService,
    NotificationWriterFanoutService,
    NotificationReadStateService,
    NotificationReadSubjectsService,
    NotificationQueryService,
    NotificationNudgesService,
    NotificationPreferencesService,
    NotificationCleanupService,
    NotificationFollowPolicyService,
    NotificationMarvWriterService,
    NotificationFanoutContentService,
    NotificationsCleanupCron,
    NotificationsOrphanCleanupCron,
    NotificationsEmailCron,
    NotificationsEmailWeeklyService,
    NotificationsReplyNudgeCron,
    OnThisDayCron,
    NotificationPushService,
    ApnsPushService,
  ],
})
export class NotificationsModule {}
