import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailUnsubscribeController } from './email-unsubscribe.controller';
import { NewslettersCron } from './newsletters.cron';
import { NewslettersService } from './newsletters.service';

@Module({
  imports: [AuthModule, PrismaModule, EmailModule, NotificationsModule],
  controllers: [EmailUnsubscribeController],
  providers: [NewslettersService, NewslettersCron],
  exports: [NewslettersService, NewslettersCron],
})
export class NewslettersModule {}
