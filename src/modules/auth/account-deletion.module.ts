import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { BillingModule } from '../billing/billing.module';
import { EmailModule } from '../email/email.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionFinalizeCron } from './account-deletion-finalize.cron';
import { AccountDeletionService } from './account-deletion.service';
import { AuthModule } from './auth.module';

/** Self-service account deletion. Separate from AuthModule because it depends on modules that import AuthModule. */
@Module({
  imports: [AuthModule, AdminModule, BillingModule, EmailModule, RealtimeModule, UsersModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService, AccountDeletionFinalizeCron],
  exports: [AccountDeletionFinalizeCron],
})
export class AccountDeletionModule {}
