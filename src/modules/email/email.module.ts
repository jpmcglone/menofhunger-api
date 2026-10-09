import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app/app-config.module';
import { EmailService } from './email.service';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailController } from './email.controller';
import { EmailActionTokensService } from './email-action-tokens.service';
import { GroupEmailService } from './group-email.service';
import { EmailBudgetService } from './email-budget.service';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailPreferencesService } from './email-preferences.service';
import { EmailWebhookController } from './email-webhook.controller';
import { EmailWebhookService } from './email-webhook.service';
import { EmailVerificationService } from './email-verification.service';

@Module({
  imports: [AppConfigModule, AuthModule, RealtimeModule],
  controllers: [EmailController, EmailWebhookController],
  providers: [EmailBudgetService, EmailDeliveryService, EmailPreferencesService, EmailWebhookService, ResendEmailProvider, EmailService, EmailActionTokensService, EmailVerificationService, GroupEmailService],
  exports: [EmailPreferencesService, EmailService, EmailActionTokensService, EmailVerificationService, GroupEmailService],
})
export class EmailModule {}

