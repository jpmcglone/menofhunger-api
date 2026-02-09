import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCleanupCron } from './notifications-cleanup.cron';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, forwardRef(() => PresenceModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsCleanupCron],
  exports: [NotificationsService, NotificationsCleanupCron],
})
export class NotificationsModule {}
