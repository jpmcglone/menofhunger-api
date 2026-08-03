import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FollowsController } from './follows.controller';
import { FollowsService } from './follows.service';
import { FollowsSideEffectsHandler } from './follows-side-effects.handler';

@Module({
  imports: [AuthModule, NotificationsModule, RealtimeModule],
  controllers: [FollowsController],
  providers: [FollowsService, FollowsSideEffectsHandler],
  exports: [FollowsService],
})
export class FollowsModule {}

