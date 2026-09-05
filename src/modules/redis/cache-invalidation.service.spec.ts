import { CacheInvalidationService } from './cache-invalidation.service';
import { RedisKeys } from './redis-keys';

function makeService(overrides?: {
  incr?: (key: string) => Promise<number>;
}) {
  const incr = overrides?.incr ?? (async () => 1);
  const rawObj = {
    incr: jest.fn((key: string) => incr(key)),
  };
  const redis = {
    raw: () => rawObj,
    getString: jest.fn(async () => null),
    del: jest.fn(async () => 0),
  } as any;

  const svc = new CacheInvalidationService(redis);
  return { svc, redis, rawObj };
}

describe('CacheInvalidationService.bumpForPostWrite', () => {
  it('retains feed snapshots for additive writes while invalidating search and topics', async () => {
    const { svc, rawObj } = makeService();
    await svc.bumpForPostWrite({ topics: ['faith'], invalidateFeed: false });
    expect(rawObj.incr).not.toHaveBeenCalledWith(RedisKeys.verFeedGlobal());
    expect(rawObj.incr).toHaveBeenCalledWith(RedisKeys.verSearchGlobal());
    expect(rawObj.incr).toHaveBeenCalledWith(RedisKeys.verTopic('faith'));
  });

  it('bumps feed/search and unique normalized topics', async () => {
    const { svc, rawObj } = makeService();

    await svc.bumpForPostWrite({
      topics: [' Faith ', 'faith', '  ', 'Hope', 'hope', 'HOPE', 'Charity'],
    });

    const incr = rawObj.incr as jest.Mock;
    const calledKeys = incr.mock.calls.map((c) => c[0]);

    expect(calledKeys).toContain(RedisKeys.verFeedGlobal());
    expect(calledKeys).toContain(RedisKeys.verSearchGlobal());

    // normalizeTopics trims + dedupes; it does not lowercase here because RedisKeys.verTopic lowercases.
    expect(calledKeys).toContain(RedisKeys.verTopic('Faith'));
    expect(calledKeys).toContain(RedisKeys.verTopic('Hope'));
    expect(calledKeys).toContain(RedisKeys.verTopic('Charity'));

    // Ensure only one bump per topic after normalization.
    const topicBumps = calledKeys.filter((k) => k.startsWith('ver:topic:'));
    expect(topicBumps.sort()).toEqual(
      [RedisKeys.verTopic('Faith'), RedisKeys.verTopic('Hope'), RedisKeys.verTopic('Charity')].sort(),
    );
  });
});

describe('CacheInvalidationService.bumpNotificationsList', () => {
  it('increments the per-user notifications list version', async () => {
    const { svc, rawObj } = makeService();
    await svc.bumpNotificationsList('user-1');
    const incr = rawObj.incr as jest.Mock;
    expect(incr.mock.calls.map((c) => c[0])).toContain(RedisKeys.verNotifications('user-1'));
  });
});

describe('CacheInvalidationService.bumpForYouUser', () => {
  it('increments the per-user For You version', async () => {
    const { svc, rawObj } = makeService();
    await svc.bumpForYouUser('user-1');
    const incr = rawObj.incr as jest.Mock;
    expect(incr.mock.calls.map((c) => c[0])).toContain(RedisKeys.verForYouUser('user-1'));
  });
});

