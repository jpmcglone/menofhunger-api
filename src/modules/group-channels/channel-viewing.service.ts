import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CacheService } from '../redis/cache.service';
import { RedisKeys } from '../redis/redis-keys';
import { ChannelAccessService } from './channel-access.service';

const LEASE_MS = 35_000;

/** Visible-pane leases that suppress pushes for a channel the viewer is already reading. */
@Injectable()
export class ChannelViewingService {
  constructor(private readonly access: ChannelAccessService, private readonly cache: CacheService) {}

  async viewing(userId: string, groupId: string, channelId: string, active: boolean, clientId = 'legacy') {
    await this.access.channel(userId, groupId, channelId);
    const key = RedisKeys.channelViewing(userId, channelId);
    // Each visible pane owns its lease; closing one device cannot clear another.
    const updated = await this.cache.withLock(`${key}:lock`, { ttlMs: 5000, waitMs: 1000 }, async () => {
      const now = Date.now();
      const stored = await this.cache.getJson<Record<string, number> | boolean>(key);
      const leases = Object.fromEntries(Object.entries(typeof stored === 'object' && stored ? stored : {}).filter(([, until]) => until > now));
      if (active) leases[clientId] = now + LEASE_MS;
      else delete leases[clientId];
      if (Object.keys(leases).length) await this.cache.setJson(key, leases, { ttlSeconds: LEASE_MS / 1000 });
      else await this.cache.del(key);
      return true;
    });
    if (updated === null) throw new ServiceUnavailableException('Please retry updating channel activity.');
  }

  async isViewing(userId: string, channelId: string) {
    const stored = await this.cache.getJson<Record<string, number> | boolean>(RedisKeys.channelViewing(userId, channelId));
    return stored === true || (!!stored && typeof stored === 'object' && Object.values(stored).some(until => until > Date.now()));
  }
}
