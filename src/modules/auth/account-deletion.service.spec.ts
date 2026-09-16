import { AccountDeletionService } from './account-deletion.service';
import { eraseAccountRecords } from './account-erasure';
import { BillingService } from '../billing/billing.service';
import { PresenceRealtimeService } from '../presence/presence-realtime.service';
import { PublicProfileCacheService } from '../users/public-profile-cache.service';
import { UsersMeRealtimeService } from '../users/users-me-realtime.service';
import { AdminImageReviewService } from '../admin/admin-image-review.service';
import { RedisService } from '../redis/redis.service';
import { CacheInvalidationService } from '../redis/cache-invalidation.service';
import { EmailService } from '../email/email.service';

jest.mock('./account-erasure', () => ({ eraseAccountRecords: jest.fn(async () => undefined) }));
function harness() {
  let receipt: any = { id: '11111111-1111-4111-8111-111111111111', userId: 'u1', scheduledAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000), startedAt: null, erasedAt: null, completedAt: null, cancelledAt: null, confirmationEmail: null, mediaKeys: [] };
  const user = { id: 'u1', username: 'tester', accountKind: 'person', isBot: false, email: null };
  const prisma: any = {
    user: { findUnique: jest.fn(async () => user), findMany: jest.fn(async () => []), update: jest.fn(async () => user), updateMany: jest.fn(async () => ({ count: 1 })) },
    accountDeletionReceipt: { findUnique: jest.fn(async () => receipt), findUniqueOrThrow: jest.fn(async () => receipt), findMany: jest.fn(async () => [receipt]), upsert: jest.fn(async () => receipt), update: jest.fn(async ({ data }) => { receipt = { ...receipt, ...data }; return receipt; }), deleteMany: jest.fn(async () => ({ count: 0 })) },
  };
  prisma.$transaction = jest.fn(async (fn) => fn(prisma));
  const auth: any = { revokeAllSessionsForUser: jest.fn(async () => undefined) };
  const billing = { cancelSubscriptionForAccountDeletion: jest.fn(async () => undefined) };
  const media = { accountErasureKeys: jest.fn(async () => ['uploads/u1/photo.jpg']), eraseUnreferencedAccountMedia: jest.fn(async () => undefined) };
  const redis = { withLock: jest.fn(async (_key, _options, fn) => fn()), raw: () => ({ scan: jest.fn(async () => ['0', []]), del: jest.fn() }) };
  const cache = { invalidateForUser: jest.fn(async () => undefined), bumpFeedGlobal: jest.fn(), bumpSearchGlobal: jest.fn() };
  const presence = { disconnectUserSockets: jest.fn(), emitMeUpdatedFromUser: jest.fn() };
  const email = { sendText: jest.fn(async () => ({ sent: true })) };
  const services = new Map<any, any>([[BillingService, billing], [AdminImageReviewService, media], [RedisService, redis], [CacheInvalidationService, cache], [PublicProfileCacheService, cache], [PresenceRealtimeService, presence], [UsersMeRealtimeService, presence], [EmailService, email]]);
  const service = new AccountDeletionService(prisma, auth, { get: (token: unknown) => services.get(token) } as any);
  return { service, prisma, auth, billing, media, email, redis, receipt: () => receipt, setReceipt: (data: any) => { receipt = { ...receipt, ...data }; } };
}
afterEach(() => jest.clearAllMocks());
describe('durable account deletion', () => {
  it('returns a receipt only after scheduling and revoking sessions', async () => {
    const h = harness();
    const result = await h.service.requestDeletion('u1');
    expect(result).toMatchObject({ success: true, deletionStatusToken: h.receipt().id });
    expect(h.auth.revokeAllSessionsForUser).toHaveBeenCalledWith('u1');
    expect(h.prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ bannedReason: 'self_deleted_pending' }) }));
    expect(eraseAccountRecords).not.toHaveBeenCalled();
  });
  it('does not erase records if billing cancellation fails', async () => {
    const h = harness(); h.billing.cancelSubscriptionForAccountDeletion.mockRejectedValue(new Error('offline'));
    expect(await h.service.finalizeDueDeletions()).toEqual({ finalized: 0 });
    expect(eraseAccountRecords).not.toHaveBeenCalled(); expect(h.receipt().completedAt).toBeNull();
  });
  it('retries external cleanup after database erasure without erasing twice', async () => {
    const h = harness(); h.media.eraseUnreferencedAccountMedia.mockRejectedValueOnce(new Error('storage offline'));
    expect(await h.service.finalizeDueDeletions()).toEqual({ finalized: 0 });
    expect(h.receipt().erasedAt).toBeInstanceOf(Date); expect(h.receipt().completedAt).toBeNull();
    expect(await h.service.finalizeDueDeletions()).toEqual({ finalized: 1 });
    expect(eraseAccountRecords).toHaveBeenCalledTimes(1);
    expect(h.receipt()).toMatchObject({ userId: null, confirmationEmail: null, mediaKeys: [] });
    expect(h.receipt().completedAt).toBeInstanceOf(Date);
  });
  it('does not erase a cancelled or not-yet-due account', async () => {
    const h = harness(); h.setReceipt({ cancelledAt: new Date() });
    expect(await h.service.finalizeDeletion('u1')).toBe(false);
    h.setReceipt({ cancelledAt: null, scheduledAt: new Date(Date.now() + 100000) });
    expect(await h.service.finalizeDeletion('u1')).toBe(false);
    expect(eraseAccountRecords).not.toHaveBeenCalled();
  });
  it('keeps confirmation retryable and exposes no identity in the public receipt', async () => {
    const h = harness(); h.setReceipt({ confirmationEmail: 'synthetic@example.invalid' });
    h.email.sendText.mockResolvedValueOnce({ sent: false });
    expect(await h.service.finalizeDueDeletions()).toEqual({ finalized: 0 });
    expect(await h.service.status(h.receipt().id)).toEqual({ status: 'processing', scheduledAt: h.receipt().scheduledAt.toISOString(), completedAt: null });
    expect(await h.service.finalizeDueDeletions()).toEqual({ finalized: 1 });
  });
});
