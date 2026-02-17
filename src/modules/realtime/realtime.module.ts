import { Module } from '@nestjs/common';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PresenceService } from '../presence/presence.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';

/**
 * Standalone realtime primitives (presence state + Socket.IO emission).
 *
 * Domain modules should depend on this module for emitting realtime events,
 * instead of importing PresenceModule (which also contains the gateway/controller).
 * This breaks circular dependencies between PresenceModule and domain modules.
 */
@Module({
  providers: [PresenceService, PresenceRealtimeService, PresenceRedisStateService],
  exports: [PresenceService, PresenceRealtimeService, PresenceRedisStateService],
})
export class RealtimeModule {}

