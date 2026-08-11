import { NotificationSideEffectsHandler } from './notification-side-effects.handler';
import { RedisKeys } from '../redis/redis-keys';

describe('NotificationSideEffectsHandler.onBadgeSync', () => {
  function makeHandler(opts?: {
    setStringOk?: boolean;
    lastSent?: string | null;
    iosActive?: boolean;
  }) {
    const setStringOk = opts?.setStringOk !== false;
    const apns = {
      computeAppIconBadge: jest.fn(async () => 3),
      sendBadgeOnly: jest.fn(async () => undefined),
    };
    const redis = {
      setString: jest.fn(async () => setStringOk),
      getString: jest.fn(async () => opts?.lastSent ?? null),
    };
    const presenceRedis = {
      isUserActivelyOnIos: jest.fn(async () => opts?.iosActive === true),
    };
    const sideEffects = { dispatch: jest.fn() };
    const registry = { register: jest.fn() };
    const handler = new NotificationSideEffectsHandler(
      {} as any,
      {} as any,
      registry as any,
      apns as any,
      redis as any,
      presenceRedis as any,
      sideEffects as any,
    );
    handler.onModuleInit();
    const badgeHandler = registry.register.mock.calls.find((c) => c[0] === 'notification.badge.sync')?.[1];
    return { apns, redis, presenceRedis, sideEffects, badgeHandler };
  }

  it('skips APNs when an active iOS socket exists', async () => {
    const { apns, presenceRedis, badgeHandler } = makeHandler({ iosActive: true });
    await badgeHandler({ recipientUserId: 'u1', undeliveredBellCount: 2, undeliveredGroupsCount: 1 });
    expect(presenceRedis.isUserActivelyOnIos).toHaveBeenCalledWith('u1');
    expect(apns.sendBadgeOnly).not.toHaveBeenCalled();
  });

  it('sends badge-only APNs when only web is active (ios not active)', async () => {
    const { apns, redis, badgeHandler } = makeHandler({ iosActive: false });
    await badgeHandler({ recipientUserId: 'u1', undeliveredBellCount: 2, undeliveredGroupsCount: 1 });
    expect(apns.sendBadgeOnly).toHaveBeenCalledWith('u1', 3);
    expect(redis.setString).toHaveBeenCalledWith(RedisKeys.badgeSyncLastSent('u1'), '3', {
      ttlSeconds: 86_400,
    });
  });

  it('skips send when badge equals last sent', async () => {
    const { apns, badgeHandler } = makeHandler({ lastSent: '3', iosActive: false });
    await badgeHandler({ recipientUserId: 'u1', undeliveredBellCount: 2, undeliveredGroupsCount: 1 });
    expect(apns.sendBadgeOnly).not.toHaveBeenCalled();
  });

  it('debounces rapid syncs and schedules a trailing flush', async () => {
    const { apns, sideEffects, badgeHandler } = makeHandler({ setStringOk: false });
    await badgeHandler({ recipientUserId: 'u1' });
    expect(apns.sendBadgeOnly).not.toHaveBeenCalled();
    expect(sideEffects.dispatch).toHaveBeenCalledWith(
      'notification.badge.sync',
      { recipientUserId: 'u1' },
      expect.objectContaining({ jobId: 'badge-sync-trail:u1', delay: expect.any(Number) }),
    );
  });
});
