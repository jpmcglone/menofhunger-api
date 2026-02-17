import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { EmailService } from './email.service';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { AuthModule } from '../auth/auth.module';
import { EmailController } from './email.controller';
import { EmailActionTokensService } from './email-action-tokens.service';
import { EmailVerificationService } from './email-verification.service';

@Module({
  imports: [AppConfigModule, AuthModule],
  controllers: [EmailController],
  providers: [ResendEmailProvider, EmailService, EmailActionTokensService, EmailVerificationService],
  exports: [EmailService, EmailActionTokensService, EmailVerificationService],
})
export class EmailModule {}

