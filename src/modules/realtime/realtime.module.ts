import { Module } from '@nestjs/common';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PresenceService } from '../presence/presence.service';
import { PresenceAnonymousStateService } from '../presence/presence-anonymous-state.service';
import { PresenceLobbyStateService } from '../presence/presence-lobby-state.service';
import { PresenceRedisBusService } from '../presence/presence-redis-bus.service';
import { PresenceRedisReadService } from '../presence/presence-redis-read.service';
import { PresenceRedisStateService } from '../presence/presence-redis-state.service';

/**
 * Standalone realtime primitives (presence state + Socket.IO emission).
 *
 * Domain modules should depend on this module for emitting realtime events,
 * instead of importing PresenceModule (which also contains the gateway/controller).
 * This breaks circular dependencies between PresenceModule and domain modules.
 */
@Module({
  providers: [
    PresenceService,
    PresenceRealtimeService,
    PresenceRedisBusService,
    PresenceRedisReadService,
    PresenceAnonymousStateService,
    PresenceLobbyStateService,
    PresenceRedisStateService,
  ],
  exports: [
    PresenceService,
    PresenceRealtimeService,
    PresenceRedisStateService,
    PresenceRedisBusService,
    PresenceRedisReadService,
    PresenceLobbyStateService,
    PresenceAnonymousStateService,
  ],
})
export class RealtimeModule {}

