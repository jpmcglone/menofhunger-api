import { PublicProfileCacheService } from './public-profile-cache.service';
import { RedisKeys } from '../redis/redis-keys';

function makeService(params: {
  usernameToId?: string | null;
  profileVersion?: number;
  payload?: { id: string; username: string | null } | null;
}) {
  const redis = {
    getString: jest.fn(async () => params.usernameToId ?? null),
    getJson: jest.fn(async () => params.payload ?? null),
    del: jest.fn(async () => 1),
    setJson: jest.fn(async () => true),
    setString: jest.fn(async () => true),
  } as any;

  const cacheInvalidation = {
    profileVersion: jest.fn(async () => params.profileVersion ?? 1),
    bumpProfile: jest.fn(async () => 2),
  } as any;

  const svc = new PublicProfileCacheService(redis, cacheInvalidation);
  return { svc, redis, cacheInvalidation };
}

describe('PublicProfileCacheService', () => {
  it('returns null and deletes resolver when username mapping is stale', async () => {
    const { svc, redis } = makeService({
      usernameToId: 'user_1',
      profileVersion: 7,
      payload: { id: 'user_1', username: 'newname' },
    });

    const res = await svc.read('username:oldname');
    expect(res).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(RedisKeys.publicProfileUsernameToId('oldname'));
  });

  it('returns payload when username matches', async () => {
    const { svc, redis } = makeService({
      usernameToId: 'user_1',
      profileVersion: 2,
      payload: { id: 'user_1', username: 'same' },
    });

    const res = await svc.read('username:same');
    expect(res).toEqual({ id: 'user_1', username: 'same' });
    expect(redis.del).not.toHaveBeenCalled();
  });
});

