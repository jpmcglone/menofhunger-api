import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { EntitlementService } from './entitlement.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigModule } from '../app/app-config.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, AppConfigModule, AuthModule, UsersModule],
  controllers: [BillingController],
  providers: [BillingService, EntitlementService],
  exports: [BillingService, EntitlementService],
})
export class BillingModule {}

