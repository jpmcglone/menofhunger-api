import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublicProfileCacheService } from './public-profile-cache.service';
import { UsersMeRealtimeService } from './users-me-realtime.service';
import { UsersProfileWriteService } from './users-profile-write.service';
import { UsersPublicRealtimeService } from './users-public-realtime.service';

describe('profile save consistency', () => {
  it('waits for signed-in user cache invalidation before publishing and returning the saved name', async () => {
    const updated = { id: 'viewer', username: 'john', name: 'New name' };
    const prisma = { user: { update: jest.fn().mockResolvedValue(updated) } };
    let finishInvalidation!: () => void;
    const auth = { bustSessionCachesForUser: jest.fn(() => new Promise<void>((resolve) => { finishInvalidation = resolve; })) };
    const cache = { invalidateForUser: jest.fn().mockResolvedValue(undefined) };
    const me = { emitMeUpdatedFromUser: jest.fn() };
    const publicUpdates = { emitPublicProfileUpdated: jest.fn().mockResolvedValue(undefined) };
    const service = new UsersProfileWriteService(
      prisma as unknown as PrismaService,
      cache as unknown as PublicProfileCacheService<typeof updated>,
      me as unknown as UsersMeRealtimeService,
      publicUpdates as unknown as UsersPublicRealtimeService,
      auth as unknown as AuthService,
    );

    let returned = false;
    const save = service.commit('viewer', { name: 'New name' }).then((user) => { returned = true; return user; });
    await Promise.resolve();
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'viewer' }, data: { name: 'New name' } });
    expect(auth.bustSessionCachesForUser).toHaveBeenCalledWith('viewer');
    expect(returned).toBe(false);
    expect(me.emitMeUpdatedFromUser).not.toHaveBeenCalled();
    finishInvalidation();
    await expect(save).resolves.toEqual(updated);
    expect(cache.invalidateForUser).toHaveBeenCalledWith({ id: 'viewer', username: 'john' });
    expect(publicUpdates.emitPublicProfileUpdated).toHaveBeenCalledWith('viewer');
    expect(me.emitMeUpdatedFromUser).toHaveBeenCalledWith(updated, 'profile_changed');
  });
});
