import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { OTP_PROVIDER } from './otp/otp-provider.token';
import { TwilioVerifyOtpProvider } from './otp/twilio-verify-otp.provider';
import { NoopOtpProvider } from './otp/noop-otp.provider';
import { AuthCleanupCron } from './auth-cleanup.cron';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    TwilioVerifyOtpProvider,
    NoopOtpProvider,
    AuthCleanupCron,
    // Default OTP provider: Twilio Verify. AuthService can choose not to use it in dev.
    { provide: OTP_PROVIDER, useExisting: TwilioVerifyOtpProvider },
  ],
  exports: [AuthService, AuthGuard, AuthCleanupCron],
})
export class AuthModule {}

