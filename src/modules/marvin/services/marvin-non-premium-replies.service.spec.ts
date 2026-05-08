import { Prisma } from '@prisma/client';
import { MarvinNonPremiumRepliesService } from './marvin-non-premium-replies.service';

type Reason = 'not_premium' | 'ai_not_configured';

function makeService() {
  const claimed = new Set<string>();
  const key = (userId: string, rootPostId: string, reason: Reason) =>
    `${userId}|${rootPostId}|${reason}`;
  const prisma: any = {
    marvinNonPremiumThreadReply: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = key(
          where.userId_rootPostId_reason.userId,
          where.userId_rootPostId_reason.rootPostId,
          where.userId_rootPostId_reason.reason,
        );
        return claimed.has(k) ? { id: 'row-1' } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const k = key(data.userId, data.rootPostId, data.reason);
        if (claimed.has(k)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        claimed.add(k);
        return { id: 'row-' + claimed.size };
      }),
      update: jest.fn(async () => ({})),
    },
  };
  const svc = new MarvinNonPremiumRepliesService(prisma);
  return { svc, prisma };
}

describe('MarvinNonPremiumRepliesService', () => {
  it('hasAlreadyReplied is false initially, true after a successful claim', async () => {
    const { svc } = makeService();
    expect(
      await svc.hasAlreadyReplied({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(false);
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
    expect(
      await svc.hasAlreadyReplied({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
  });

  it('tryClaim returns false on duplicate (P2002)', async () => {
    const { svc } = makeService();
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(false);
  });

  it('tryClaim allows distinct (user, rootPostId) pairs', async () => {
    const { svc } = makeService();
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r2', reason: 'not_premium' }),
    ).toBe(true);
    expect(
      await svc.tryClaim({ userId: 'u2', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
  });

  // Each reason is its own slot. A user who already saw the "premium-only" reply
  // for a thread can still receive the "AI not configured" reply for the same
  // thread (and vice-versa). The unique index is (userId, rootPostId, reason).
  it('tryClaim treats reasons as independent slots', async () => {
    const { svc } = makeService();
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(true);
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'ai_not_configured' }),
    ).toBe(true);
    // Re-claiming either slot still returns false.
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'not_premium' }),
    ).toBe(false);
    expect(
      await svc.tryClaim({ userId: 'u1', rootPostId: 'r1', reason: 'ai_not_configured' }),
    ).toBe(false);
  });

  it('setMarvPostId swallows update errors (best-effort)', async () => {
    const { svc, prisma } = makeService();
    prisma.marvinNonPremiumThreadReply.update.mockRejectedValueOnce(new Error('boom'));
    await expect(
      svc.setMarvPostId({
        userId: 'u1',
        rootPostId: 'r1',
        reason: 'not_premium',
        marvinPostId: 'p1',
      }),
    ).resolves.toBeUndefined();
  });
});
