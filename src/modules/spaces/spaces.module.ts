import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SpacesChatService } from './spaces-chat.service';
import { SpacesController } from './spaces.controller';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesService } from './spaces.service';
import { SpacesSideEffectsHandler } from './spaces-side-effects.handler';
import { WatchPartyStateService } from './watch-party-state.service';

@Module({
  imports: [AuthModule, JobsModule, NotificationsModule],
  controllers: [SpacesController],
  providers: [
    SpacesService,
    SpacesPresenceService,
    SpacesChatService,
    WatchPartyStateService,
    SpacesSideEffectsHandler,
  ],
  exports: [SpacesService, SpacesPresenceService, SpacesChatService, WatchPartyStateService],
})
export class SpacesModule {}
