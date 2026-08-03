import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BillingModule } from '../billing/billing.module';
import { CoinsModule } from '../coins/coins.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { UserVerificationService } from './user-verification.service';
import { VerificationSideEffectsHandler } from './verification-side-effects.handler';

@Module({
  // Plain imports, no forwardRef: the dependency direction here is strictly one-way.
  // Auth and Billing used to import this module back (for the auto-verify call) and that
  // cycle is gone — they dispatch `user.auto-verify` instead.
  imports: [PrismaModule, AuthModule, UsersModule, RealtimeModule, BillingModule, CoinsModule, NotificationsModule],
  controllers: [VerificationController],
  providers: [VerificationService, UserVerificationService, VerificationSideEffectsHandler],
  exports: [VerificationService, UserVerificationService],
})
export class VerificationModule {}
