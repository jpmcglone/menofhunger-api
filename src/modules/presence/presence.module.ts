import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { MarvinModule } from '../marvin/marvin.module';
import { MessagesModule } from '../messages/messages.module';
import { RadioModule } from '../radio/radio.module';
import { SpacesModule } from '../spaces/spaces.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '../redis/redis.module';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from './presence.gateway';

@Module({
  imports: [
    AuthModule,
    FollowsModule,
    MessagesModule,
    RadioModule,
    SpacesModule,
    RealtimeModule,
    RedisModule,
    // Used only to inject `MarvinBotIdentityService` so we can prepend the synthetic
    // Marv "always online" row to /presence/online and the websocket snapshot.
    // MarvinModule does not depend on PresenceModule, so this is acyclic.
    MarvinModule,
  ],
  controllers: [PresenceController],
  providers: [PresenceGateway],
  exports: [RealtimeModule],
})
export class PresenceModule {}
