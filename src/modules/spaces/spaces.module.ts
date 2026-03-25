import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SpacesChatService } from './spaces-chat.service';
import { SpacesController } from './spaces.controller';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesService } from './spaces.service';
import { WatchPartyStateService } from './watch-party-state.service';

@Module({
  imports: [AuthModule],
  controllers: [SpacesController],
  providers: [SpacesService, SpacesPresenceService, SpacesChatService, WatchPartyStateService],
  exports: [SpacesService, SpacesPresenceService, SpacesChatService, WatchPartyStateService],
})
export class SpacesModule {}
