import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { UsersProfileWriteService } from './users-profile-write.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EmailModule } from '../email/email.module';
import { UsersController } from './users.controller';
import { UsersDiscoveryService } from './users-discovery.service';
import { UsersPreferencesService } from './users-preferences.service';
import { UsersPublicProfileService } from './users-public-profile.service';
import { UsersMeService } from './users-me.service';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { UsersRealtimeService } from './users-realtime.service';
import { UsersLocationService } from './users-location.service';
import { UsersMeRealtimeService } from './users-me-realtime.service';
import { UsersPublicRealtimeService } from './users-public-realtime.service';
import { PublicProfilesService } from './public-profiles.service';
import { ProfileLinksService } from './profile-links.service';
import { ProfileLinksWriteService } from './profile-links-write.service';
import { MembersMapController } from './members-map.controller';
import { MembersMapService } from './members-map.service';
import { MembersMapRealtimeService } from './members-map-realtime.service';

@Module({
  imports: [AuthModule, FollowsModule, NotificationsModule, RealtimeModule, EmailModule],
  // Fixed `users/...` routes must register before UsersController's `users/:username`.
  controllers: [ActivationController, MembersMapController, UsersController],
  providers: [
    ActivationService,
    MembersMapService,
    MembersMapRealtimeService,
    UsersProfileWriteService,
    PublicProfileCacheService,
    UsersRealtimeService,
    UsersLocationService,
    UsersMeRealtimeService,
    UsersPublicRealtimeService,
    PublicProfilesService,
    UsersDiscoveryService,
    UsersPreferencesService,
    UsersPublicProfileService,
    UsersMeService,
    ProfileLinksService,
    ProfileLinksWriteService,
  ],
  exports: [
    ProfileLinksService,
    ProfileLinksWriteService,
    UsersProfileWriteService,
    PublicProfileCacheService,
    UsersRealtimeService,
    UsersLocationService,
    UsersMeRealtimeService,
    UsersPublicRealtimeService,
    PublicProfilesService,
  ],
})
export class UsersModule {}

