import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { BillingGrantExpiryCron } from './billing-grant-expiry.cron';
import { ReferralService } from './referral.service';
import { ReferralDigestEmailCron } from './referral-digest-email.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigModule } from '../app/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { FollowsModule } from '../follows/follows.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, AppConfigModule, AuthModule, UsersModule, FollowsModule, EmailModule],
  controllers: [BillingController],
  providers: [BillingService, EntitlementService, BillingGrantExpiryCron, ReferralService, ReferralDigestEmailCron],
  exports: [BillingService, EntitlementService, ReferralService],
})
export class BillingModule {}

