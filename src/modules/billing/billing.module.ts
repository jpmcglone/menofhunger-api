import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { BillingGrantExpiryCron } from './billing-grant-expiry.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigModule } from '../app/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, AppConfigModule, AuthModule, UsersModule],
  controllers: [BillingController],
  providers: [BillingService, EntitlementService, BillingGrantExpiryCron],
  exports: [BillingService, EntitlementService],
})
export class BillingModule {}

