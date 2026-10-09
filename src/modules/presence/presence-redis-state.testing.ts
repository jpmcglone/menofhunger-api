import type { AppConfigService } from '../app/app-config.service';
import type { RedisService } from '../redis/redis.service';
import { PresenceAnonymousStateService } from './presence-anonymous-state.service';
import { PresenceLobbyStateService } from './presence-lobby-state.service';
import { PresenceRedisBusService } from './presence-redis-bus.service';
import { PresenceRedisReadService } from './presence-redis-read.service';
import { PresenceRedisStateService } from './presence-redis-state.service';
import type { PresenceService } from './presence.service';

/** Wires PresenceRedisStateService and its collaborators by hand for unit tests (the module does this through DI). */
export function makePresenceRedisState(
  redis: RedisService,
  appConfig: AppConfigService,
  presence: PresenceService,
): {
  state: PresenceRedisStateService;
  bus: PresenceRedisBusService;
  read: PresenceRedisReadService;
  anon: PresenceAnonymousStateService;
  lobby: PresenceLobbyStateService;
} {
  const bus = new PresenceRedisBusService(redis);
  const read = new PresenceRedisReadService(redis, bus, presence);
  const anon = new PresenceAnonymousStateService(redis, bus, read);
  const lobby = new PresenceLobbyStateService(redis, bus);
  const state = new PresenceRedisStateService(redis, appConfig, presence, bus, read, anon);
  return { state, bus, read, anon, lobby };
}
