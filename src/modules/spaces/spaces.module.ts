import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { LinkMetadataModule } from '../link-metadata/link-metadata.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SpacesChatService } from './spaces-chat.service';
import { SpacesController } from './spaces.controller';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesService } from './spaces.service';
import { SpacesIdleCleanupCron } from './spaces-idle-cleanup.cron';
import { SpacesSideEffectsHandler } from './spaces-side-effects.handler';
import { WatchPartyStateService } from './watch-party-state.service';

@Module({
  imports: [AuthModule, JobsModule, LinkMetadataModule, NotificationsModule, RealtimeModule],
  controllers: [SpacesController],
  providers: [
    SpacesService,
    SpacesPresenceService,
    SpacesChatService,
    WatchPartyStateService,
    SpacesSideEffectsHandler,
    SpacesIdleCleanupCron,
  ],
  exports: [SpacesService, SpacesPresenceService, SpacesChatService, WatchPartyStateService],
})
export class SpacesModule {}
