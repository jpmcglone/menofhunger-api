import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersController } from './users.controller';
import { PublicProfileCacheService } from './public-profile-cache.service';

@Module({
  imports: [AuthModule, FollowsModule, NotificationsModule],
  controllers: [UsersController],
  providers: [PublicProfileCacheService],
  exports: [PublicProfileCacheService],
})
export class UsersModule {}

