import { InsufficientMarvCreditsError, MarvinCreditService } from './marvin-credit.service';

type Bucket = { credits: number; lastRefilledAt: Date } | null;

function makeService(initialBucket: Bucket = null) {
  let bucket: Bucket = initialBucket
    ? { credits: initialBucket.credits, lastRefilledAt: new Date(initialBucket.lastRefilledAt) }
    : null;

  const tx: any = {
    marvinCreditBalance: {
      findUnique: jest.fn(async () =>
        bucket ? { credits: bucket.credits, lastRefilledAt: bucket.lastRefilledAt } : null,
      ),
      create: jest.fn(async ({ data }: any) => {
        bucket = { credits: data.credits, lastRefilledAt: data.lastRefilledAt };
        return { credits: bucket.credits, lastRefilledAt: bucket.lastRefilledAt };
      }),
      update: jest.fn(async ({ data }: any) => {
        bucket = { credits: data.credits, lastRefilledAt: data.lastRefilledAt };
        return { credits: bucket.credits, lastRefilledAt: bucket.lastRefilledAt };
      }),
      // Atomic guarded decrement used by spend()
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!bucket) return { count: 0 };
        const cost = typeof data.credits?.decrement === 'number' ? data.credits.decrement : 0;
        if (bucket.credits < (where.credits?.gte ?? 0)) return { count: 0 };
        bucket = {
          credits: Math.max(0, bucket.credits - cost),
          lastRefilledAt: data.lastRefilledAt ?? bucket.lastRefilledAt,
        };
        return { count: 1 };
      }),
      upsert: jest.fn(async ({ create, update: _upd }: any) => {
        if (!bucket) {
          bucket = { credits: create.credits, lastRefilledAt: create.lastRefilledAt };
        }
        return { credits: bucket.credits, lastRefilledAt: bucket.lastRefilledAt };
      }),
    },
  };

  const prisma: any = {
    marvinCreditBalance: tx.marvinCreditBalance,
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const appConfig: any = {
    marvCredits: jest.fn(() => ({
      monthlyCredits: 1200,
      maxCredits: 1500,
      creditsPerDay: 40,
      fastCost: 1,
      regularCost: 2,
      smartCost: 4,
    })),
  };

  const svc = new MarvinCreditService(prisma, appConfig);
  return { svc, prisma, getBucket: () => bucket };
}

describe('MarvinCreditService', () => {
  describe('costForMode', () => {
    it('returns the configured per-mode cost', () => {
      const { svc } = makeService();
      expect(svc.costForMode('fast')).toBe(1);
      expect(svc.costForMode('regular')).toBe(2);
      expect(svc.costForMode('smart')).toBe(4);
    });
  });

  describe('refill', () => {
    it('lazily creates a bucket at the monthly starting balance for new users', async () => {
      const { svc, getBucket } = makeService(null);
      const result = await svc.refill('u1');
      expect(result.credits).toBe(1200);
      expect(result.maxCredits).toBe(1500);
      expect(result.creditsPerDay).toBe(40);
      expect(getBucket()?.credits).toBe(1200);
    });

    it('accrues credits proportionally to elapsed time', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const t1 = new Date('2026-01-01T12:00:00Z'); // 12h later → +20 credits
      const { svc } = makeService({ credits: 100, lastRefilledAt: t0 });
      const result = await svc.refill('u1', t1);
      expect(result.credits).toBeCloseTo(120, 5);
    });

    it('caps the bucket at maxCredits', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const t1 = new Date('2026-12-31T00:00:00Z'); // ~365d later → +14600 credits, capped at 1500
      const { svc } = makeService({ credits: 1499, lastRefilledAt: t0 });
      const result = await svc.refill('u1', t1);
      expect(result.credits).toBe(1500);
    });

    it('skips a write when nothing meaningfully changed (capped + within 60s window)', async () => {
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const t1 = new Date('2026-01-01T00:00:30.000Z'); // 30s — sub-grain
      // Already at the bucket max — refill capping makes `next` === existing.credits exactly.
      const { svc, prisma } = makeService({ credits: 1500, lastRefilledAt: t0 });
      await svc.refill('u1', t1);
      // findUnique was called inside the tx; update should not have been called.
      expect(prisma.marvinCreditBalance.update).not.toHaveBeenCalled();
    });
  });

  describe('spend', () => {
    it('decrements credits and returns the post-spend summary', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const { svc, getBucket } = makeService({ credits: 50, lastRefilledAt: t0 });
      const summary = await svc.spend('u1', 4, { now: t0 });
      expect(summary.credits).toBe(46);
      expect(getBucket()?.credits).toBe(46);
    });

    it('throws InsufficientMarvCreditsError when balance is too low', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      const { svc } = makeService({ credits: 1, lastRefilledAt: t0 });
      await expect(svc.spend('u1', 4, { now: t0 })).rejects.toBeInstanceOf(InsufficientMarvCreditsError);
    });

    it('skips the inner refill SELECT when a recent summary is passed', async () => {
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const t1 = new Date('2026-01-01T00:00:01.500Z'); // 1.5s after refill — within window
      const { svc, prisma, getBucket } = makeService({ credits: 50, lastRefilledAt: t0 });
      const summary = await svc.spend('u1', 4, {
        now: t1,
        recentSummary: { credits: 50, lastRefilledAt: t0 },
      });
      expect(summary.credits).toBe(46);
      expect(getBucket()?.credits).toBe(46);
      // findUnique inside the tx is called once for the post-decrement read (NOT for the
      // inner refill SELECT, which is skipped when recentSummary is fresh).
      expect(prisma.marvinCreditBalance.findUnique).toHaveBeenCalledTimes(1);
      // We still ran exactly one updateMany (the guarded decrement).
      expect(prisma.marvinCreditBalance.updateMany).toHaveBeenCalledTimes(1);
    });

    it('falls back to a normal refill when the recent summary is too old', async () => {
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      const tooLate = new Date('2026-01-01T00:00:30.000Z'); // 30s — outside the 5s window
      const { svc, prisma } = makeService({ credits: 50, lastRefilledAt: t0 });
      await svc.spend('u1', 4, {
        now: tooLate,
        recentSummary: { credits: 50, lastRefilledAt: t0 },
      });
      // Stale summary → must run the inner refill SELECT.
      expect(prisma.marvinCreditBalance.findUnique).toHaveBeenCalled();
    });

    it('atomic guard: only one of two concurrent spends succeeds when balance covers only one', async () => {
      // Simulate two transactions reading the same balance (10 credits) and both trying
      // to spend 10. The WHERE credits >= cost guard ensures only one succeeds.
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      let bucket = { credits: 10, lastRefilledAt: t0 };

      let firstCallDecremented = false;
      const txA: any = {
        marvinCreditBalance: {
          findUnique: jest.fn(async () => ({ credits: bucket.credits, lastRefilledAt: bucket.lastRefilledAt })),
          update: jest.fn(),
          updateMany: jest.fn(async ({ where, data }: any) => {
            const cost = data.credits?.decrement ?? 0;
            if (bucket.credits < (where.credits?.gte ?? 0)) return { count: 0 };
            if (!firstCallDecremented) {
              // Simulate T1 wins: decrements first
              bucket = { credits: bucket.credits - cost, lastRefilledAt: data.lastRefilledAt ?? bucket.lastRefilledAt };
              firstCallDecremented = true;
              return { count: 1 };
            }
            // T2 sees the decremented bucket → WHERE credits >= cost fails
            return { count: 0 };
          }),
        },
      };

      const prismaA: any = {
        marvinCreditBalance: txA.marvinCreditBalance,
        $transaction: jest.fn(async (fn: any) => fn(txA)),
      };
      const appConfig: any = {
        marvCredits: jest.fn(() => ({ monthlyCredits: 1200, maxCredits: 1500, creditsPerDay: 40, fastCost: 1, regularCost: 2, smartCost: 4 })),
      };

      const svc = new MarvinCreditService(prismaA, appConfig);
      const results = await Promise.allSettled([
        svc.spend('u1', 10, { now: t0, recentSummary: { credits: 10, lastRefilledAt: t0 } }),
        svc.spend('u1', 10, { now: t0, recentSummary: { credits: 10, lastRefilledAt: t0 } }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientMarvCreditsError);
      // Balance should be 0 after the one successful spend
      expect(bucket.credits).toBe(0);
    });
  });

  describe('msUntilCredits', () => {
    it('returns 0 when the user already has enough', () => {
      const { svc } = makeService();
      expect(svc.msUntilCredits(100, 50)).toBe(0);
    });

    it('returns proportional time based on creditsPerDay', () => {
      const { svc } = makeService();
      // Need 40 more credits at 40/day → 24h
      const ms = svc.msUntilCredits(0, 40);
      expect(ms).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('humanizeMs', () => {
    it('returns a human-friendly relative window', () => {
      expect(MarvinCreditService.humanizeMs(0)).toBe('a moment');
      expect(MarvinCreditService.humanizeMs(30_000)).toBe('a moment');
      expect(MarvinCreditService.humanizeMs(60 * 60 * 1000)).toMatch(/hour/);
      expect(MarvinCreditService.humanizeMs(48 * 60 * 60 * 1000)).toMatch(/day/);
    });
  });

  describe('setCredits', () => {
    it('caps writes at maxCredits', async () => {
      const { svc } = makeService();
      const summary = await svc.setCredits('u1', 99_999);
      expect(summary.credits).toBe(1500);
    });

    it('rejects negative credits', async () => {
      const { svc } = makeService();
      await expect(svc.setCredits('u1', -1)).rejects.toThrow(/non-negative/);
    });
  });
});
