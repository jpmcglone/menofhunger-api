import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { BillingGrantExpiryCron } from './billing-grant-expiry.cron';
import { ReferralService } from './referral.service';
import { ReferralDigestEmailCron } from './referral-digest-email.cron';
import { AffiliateService } from './affiliate.service';
import { AffiliateRetentionCron } from './affiliate-retention.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigModule } from '../app/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { FollowsModule } from '../follows/follows.module';
import { EmailModule } from '../email/email.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PrismaModule, AppConfigModule, AuthModule, UsersModule, FollowsModule, EmailModule, RealtimeModule],
  controllers: [BillingController],
  providers: [BillingService, EntitlementService, BillingGrantExpiryCron, ReferralService, ReferralDigestEmailCron, AffiliateService, AffiliateRetentionCron],
  exports: [BillingService, EntitlementService, ReferralService, AffiliateService],
})
export class BillingModule {}

