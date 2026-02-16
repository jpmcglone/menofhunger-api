import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersController } from './users.controller';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { UsersRealtimeService } from './users-realtime.service';
import { UsersLocationService } from './users-location.service';

@Module({
  imports: [AuthModule, FollowsModule, NotificationsModule, RealtimeModule],
  controllers: [UsersController],
  providers: [PublicProfileCacheService, UsersRealtimeService, UsersLocationService],
  exports: [PublicProfileCacheService, UsersRealtimeService, UsersLocationService],
})
export class UsersModule {}

