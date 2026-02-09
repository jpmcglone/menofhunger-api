import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PresenceModule } from '../presence/presence.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCleanupCron } from './notifications-cleanup.cron';
import { NotificationsOrphanCleanupCron } from './notifications-orphan-cleanup.cron';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, forwardRef(() => PresenceModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsCleanupCron, NotificationsOrphanCleanupCron],
  exports: [NotificationsService, NotificationsCleanupCron, NotificationsOrphanCleanupCron],
})
export class NotificationsModule {}
