import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { MessagesModule } from '../messages/messages.module';
import { RadioModule } from '../radio/radio.module';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from './presence.gateway';
import { PresenceRealtimeService } from './presence-realtime.service';
import { PresenceService } from './presence.service';

@Module({
  imports: [AuthModule, forwardRef(() => FollowsModule), forwardRef(() => MessagesModule), RadioModule],
  controllers: [PresenceController],
  providers: [PresenceGateway, PresenceService, PresenceRealtimeService],
  exports: [PresenceService, PresenceRealtimeService],
})
export class PresenceModule {}
