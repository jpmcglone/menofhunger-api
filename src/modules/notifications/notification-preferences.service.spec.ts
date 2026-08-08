import { NotificationPreferencesService } from './notification-preferences.service';
import { RedisKeys } from '../redis/redis-keys';

function makePrismaPrefs(row?: Record<string, unknown>) {
  const defaultRow = {
    userId: 'u1',
    pushComment: true,
    pushBoost: true,
    pushFollow: true,
    pushMention: true,
    pushMessage: true,
    pushRepost: true,
    pushNudge: true,
    pushFollowedPost: true,
    pushReplyNudge: true,
    pushCrewStreak: true,
    pushGroupActivity: true,
    pushDailyContent: true,
    pushCheckinReminder: true,
    emailDigestWeekly: false,
    emailNewNotifications: false,
    emailInstantHighSignal: false,
    emailStreakReminder: false,
    emailFollowedArticle: false,
  };
  const resolved = { ...defaultRow, ...(row ?? {}) };
  return {
    notificationPreferences: {
      upsert: jest.fn(async () => resolved),
    },
    user: {
      findUnique: jest.fn(async () => null),
    },
  };
}

function makeCache() {
  const store = new Map<string, unknown>();
  return {
    store,
    getOrSetJson: jest.fn(async ({ key, compute }: { key: string; compute: () => Promise<unknown> }) => {
      if (store.has(key)) return store.get(key);
      const v = await compute();
      store.set(key, v);
      return v;
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
    }),
  };
}

function makeService(opts?: { prismaRow?: Record<string, unknown> }) {
  const prisma = makePrismaPrefs(opts?.prismaRow);
  const cache = makeCache();
  const svc = new NotificationPreferencesService(prisma as any, cache as any);
  return { svc, prisma, cache };
}

describe('NotificationPreferencesService — caching', () => {
  it('getPreferencesInternal reads from DB on first call', async () => {
    const { svc, prisma } = makeService();
    await svc.getPreferencesInternal('u1');
    expect(prisma.notificationPreferences.upsert).toHaveBeenCalledTimes(1);
  });

  it('getPreferencesInternal serves subsequent calls from cache, skipping DB', async () => {
    const { svc, prisma } = makeService();
    await svc.getPreferencesInternal('u1');
    await svc.getPreferencesInternal('u1');
    await svc.getPreferencesInternal('u1');
    // Only one DB call — the other two should be cache hits.
    expect(prisma.notificationPreferences.upsert).toHaveBeenCalledTimes(1);
  });

  it('updatePreferences invalidates cache before writing', async () => {
    const { svc, cache } = makeService();
    // Warm the cache.
    await svc.getPreferencesInternal('u1');
    // Now update — should del before writing.
    await svc.updatePreferences('u1', { pushFollow: false });
    expect(cache.del).toHaveBeenCalledWith(RedisKeys.pushPrefs('u1'));
  });

  it('updatePreferences write-throughs the new value into cache', async () => {
    const { svc, cache } = makeService();
    await svc.updatePreferences('u1', { pushComment: false });
    expect(cache.setJson).toHaveBeenCalledWith(
      RedisKeys.pushPrefs('u1'),
      expect.objectContaining({ userId: 'u1' }),
      expect.objectContaining({ ttlSeconds: expect.any(Number) }),
    );
  });
});
