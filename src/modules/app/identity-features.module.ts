import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthMeModule } from '../auth/auth-me.module';
import { AccountDeletionModule } from '../auth/account-deletion.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MessagesModule } from '../messages/messages.module';
import { PresenceModule } from '../presence/presence.module';
import { ReportsModule } from '../reports/reports.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { AnnouncementsModule } from '../announcements/announcements.module';
import { NewslettersModule } from '../newsletters/newsletters.module';

/** Aggregate wiring for identity, billing, and member communications. Imports only; providers stay scoped to their own modules. */
@Module({
  imports: [
    AuthModule,
    AuthMeModule,
    AccountDeletionModule,
    UsersModule,
    VerificationModule,
    BillingModule,
    EmailModule,
    NotificationsModule,
    MessagesModule,
    PresenceModule,
    ReportsModule,
    FeedbackModule,
    AnnouncementsModule,
    NewslettersModule,
  ],
})
export class IdentityFeaturesModule {}
