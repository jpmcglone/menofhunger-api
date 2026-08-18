import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountDeletionService } from './account-deletion.service';
import { AuthGuard } from './auth.guard';
import { OTP_PROVIDER } from './otp/otp-provider.token';
import { TwilioVerifyOtpProvider } from './otp/twilio-verify-otp.provider';
import { NoopOtpProvider } from './otp/noop-otp.provider';
import { AuthCleanupCron } from './auth-cleanup.cron';
import { AccountDeletionFinalizeCron } from './account-deletion-finalize.cron';
import { RealtimeModule } from '../realtime/realtime.module';
import { BrowserHandoffService } from './browser-handoff.service';
import { ImpersonationService } from './impersonation.service';
import { AccountSwitchService } from './account-switch.service';

@Module({
  imports: [RealtimeModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    BrowserHandoffService,
    ImpersonationService,
    AccountSwitchService,
    AccountDeletionService,
    AuthGuard,
    TwilioVerifyOtpProvider,
    NoopOtpProvider,
    AuthCleanupCron,
    AccountDeletionFinalizeCron,
    // Default OTP provider: Twilio Verify. AuthService can choose not to use it in dev.
    { provide: OTP_PROVIDER, useExisting: TwilioVerifyOtpProvider },
  ],
  exports: [AuthService, AuthGuard, ImpersonationService, AccountSwitchService, AuthCleanupCron, AccountDeletionFinalizeCron],
})
export class AuthModule {}
