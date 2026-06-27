import { AccountDeletionService } from './account-deletion.service';
import { BillingService } from '../billing/billing.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';

function makeHarness() {
  const user = {
    id: 'user-1',
    username: 'tester',
    isBot: false,
    bannedAt: null,
    bannedReason: null,
  };
  const updated = { ...user, bannedAt: new Date('2026-06-26T00:00:00.000Z') };
  const prisma = {
    user: {
      findUnique: jest.fn(async () => user),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => updated),
    },
  } as any;
  const auth = {
    revokeAllSessionsForUser: jest.fn(async () => undefined),
  } as any;
  const billing = {
    cancelSubscriptionForAccountDeletion: jest.fn(async () => undefined),
  };
  const presenceRealtime = {
    disconnectUserSockets: jest.fn(),
  };
  const usersMeRealtime = {
    emitMeUpdatedFromUser: jest.fn(),
  };
  const publicProfileCache = {
    invalidateForUser: jest.fn(async () => undefined),
  };
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === BillingService) return billing;
      if (token === PresenceRealtimeService) return presenceRealtime;
      if (token === UsersMeRealtimeService) return usersMeRealtime;
      if (token === PublicProfileCacheService) return publicProfileCache;
      return undefined;
    }),
  } as any;
  const service = new AccountDeletionService(prisma, auth, moduleRef);

  return { service, prisma, auth, billing, presenceRealtime, usersMeRealtime, publicProfileCache };
}

describe('AccountDeletionService', () => {
  it('marks an account for deletion without wiping PII immediately', async () => {
    const { service, prisma, auth, presenceRealtime, usersMeRealtime, publicProfileCache } = makeHarness();

    const result = await service.requestDeletion('user-1', {
      reason: 'privacy',
      details: 'Please delete me',
    });

    expect(result.success).toBe(true);
    expect(result.deletionScheduledAt).toEqual(expect.any(String));
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const update = prisma.user.update.mock.calls[0][0];
    expect(update.data).toMatchObject({
      bannedReason: 'self_deleted_pending',
      deletionRequestedAt: expect.any(Date),
      deletionScheduledAt: expect.any(Date),
    });
    expect(update.data.phone).toBeUndefined();
    expect(update.data.email).toBeUndefined();
    expect(auth.revokeAllSessionsForUser).toHaveBeenCalledWith('user-1');
    expect(presenceRealtime.disconnectUserSockets).toHaveBeenCalledWith('user-1');
    expect(usersMeRealtime.emitMeUpdatedFromUser).toHaveBeenCalledWith(expect.anything(), 'account_deleted');
    expect(publicProfileCache.invalidateForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', username: 'tester' }));
  });

  it('finalizes due pending deletions by anonymizing the account', async () => {
    const { service, prisma, auth, billing, presenceRealtime, publicProfileCache } = makeHarness();
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'user-1' }]);
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-1',
      username: 'tester',
      isBot: false,
      bannedAt: new Date('2026-06-26T00:00:00.000Z'),
      bannedReason: 'self_deleted_pending',
    });

    const result = await service.finalizeDueDeletions();

    expect(result).toEqual({ finalized: 1 });
    expect(billing.cancelSubscriptionForAccountDeletion).toHaveBeenCalledWith('user-1');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      phone: 'deleted:user-1',
      email: null,
      username: null,
      name: null,
      bannedReason: 'self_deleted',
      deletionRequestedAt: null,
      deletionScheduledAt: null,
    });
    expect(auth.revokeAllSessionsForUser).toHaveBeenCalledWith('user-1');
    expect(presenceRealtime.disconnectUserSockets).toHaveBeenCalledWith('user-1');
    expect(publicProfileCache.invalidateForUser).toHaveBeenCalledWith({ id: 'user-1', username: 'tester' });
  });
});
