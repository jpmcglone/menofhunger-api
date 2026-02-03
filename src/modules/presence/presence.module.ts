import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FollowsModule } from '../follows/follows.module';
import { PresenceController } from './presence.controller';
import { PresenceGateway } from './presence.gateway';
import { PresenceService } from './presence.service';

@Module({
  imports: [AuthModule, forwardRef(() => FollowsModule)],
  controllers: [PresenceController],
  providers: [PresenceGateway, PresenceService],
  exports: [PresenceService, PresenceGateway],
})
export class PresenceModule {}
