import { Module } from '@nestjs/common';
import { SpacesChatService } from './spaces-chat.service';
import { SpacesController } from './spaces.controller';
import { SpacesPresenceService } from './spaces-presence.service';
import { SpacesService } from './spaces.service';

@Module({
  controllers: [SpacesController],
  providers: [SpacesService, SpacesPresenceService, SpacesChatService],
  exports: [SpacesService, SpacesPresenceService, SpacesChatService],
})
export class SpacesModule {}

