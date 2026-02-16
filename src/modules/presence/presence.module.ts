import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { MessagesModule } from '../messages/messages.module';
import { RadioModule } from '../radio/radio.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from './presence.gateway';

@Module({
  imports: [AuthModule, FollowsModule, MessagesModule, RadioModule, RealtimeModule],
  controllers: [PresenceController],
  providers: [PresenceGateway],
  exports: [RealtimeModule],
})
export class PresenceModule {}
