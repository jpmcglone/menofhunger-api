import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from './presence.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [AuthModule, FollowsModule],
  controllers: [PresenceController],
  providers: [PresenceGateway, PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
