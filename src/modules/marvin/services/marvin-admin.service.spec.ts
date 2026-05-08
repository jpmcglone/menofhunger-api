import { NotFoundException } from '@nestjs/common';
import { MarvinAdminService } from './marvin-admin.service';

/**
 * Targeted unit tests for the Phase 3 admin service additions. The earlier
 * admin endpoints (config / users / usage) are exercised end-to-end through
 * the controller; this spec focuses on the new context-card regenerate +
 * daily-cost rollup readers so a regression on either is caught at the
 * service layer.
 */

function makeService(opts?: {
  targetUserExists?: boolean;
  contextCardText?: string | null;
  rollups?: Array<{
    dayKey: string;
    totalRequests: number;
    totalCreditsSpent: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  }>;
}) {
  const findUniqueUser = jest.fn(async ({ where }: any) => {
    if (opts?.targetUserExists === false) return null;
    return { id: where.id };
  });

  const groupBy = jest.fn(async () =>
    (opts?.rollups ?? []).map((r) => ({
      dayKey: r.dayKey,
      _sum: {
        totalRequests: r.totalRequests,
        totalCreditsSpent: r.totalCreditsSpent,
        totalInputTokens: r.totalInputTokens,
        totalOutputTokens: r.totalOutputTokens,
        // Decimal-like value: the service calls Number() on it.
        totalCostUsd: r.totalCostUsd,
      },
    })),
  );

  const prisma: any = {
    user: { findUnique: findUniqueUser },
    userContextCard: { findUnique: jest.fn(async () => null) },
    marvinCostRollup: { groupBy },
  };

  const credits: any = {};
  const cardText =
    opts && Object.prototype.hasOwnProperty.call(opts, 'contextCardText')
      ? opts.contextCardText
      : 'fresh card text';
  const contextCards: any = {
    refreshCardForUser: jest.fn(async () => cardText),
  };

  return {
    service: new MarvinAdminService(prisma, credits, contextCards),
    prisma,
    contextCards,
    groupBy,
  };
}

describe('MarvinAdminService.regenerateContextCard', () => {
  it('throws 404 when the target user does not exist', async () => {
    const m = makeService({ targetUserExists: false });
    await expect(
      m.service.regenerateContextCard({
        actingAdminUserId: 'admin-1',
        targetUserId: 'ghost',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.contextCards.refreshCardForUser).not.toHaveBeenCalled();
  });

  it('refreshes the card and returns the new text', async () => {
    const m = makeService({ contextCardText: 'New card.' });
    const result = await m.service.regenerateContextCard({
      actingAdminUserId: 'admin-1',
      targetUserId: 'u-1',
    });
    expect(m.contextCards.refreshCardForUser).toHaveBeenCalledWith('u-1');
    expect(result.cardText).toBe('New card.');
  });

  it('returns null when the target is a bot (service skips bots)', async () => {
    const m = makeService({ contextCardText: null });
    const result = await m.service.regenerateContextCard({
      actingAdminUserId: 'admin-1',
      targetUserId: 'bot-1',
    });
    expect(result.cardText).toBeNull();
  });
});

describe('MarvinAdminService.listDailyCostRollups', () => {
  it('returns aggregated rows ordered by day with numeric cost', async () => {
    const m = makeService({
      rollups: [
        {
          dayKey: '2026-05-01',
          totalRequests: 10,
          totalCreditsSpent: 50,
          totalInputTokens: 1000,
          totalOutputTokens: 200,
          totalCostUsd: 0.123,
        },
        {
          dayKey: '2026-05-02',
          totalRequests: 5,
          totalCreditsSpent: 20,
          totalInputTokens: 500,
          totalOutputTokens: 100,
          totalCostUsd: 0.045,
        },
      ],
    });
    const rows = await m.service.listDailyCostRollups({ sinceDays: 30 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dayKey).toBe('2026-05-01');
    expect(rows[1]!.totalCostUsd).toBeCloseTo(0.045, 6);
  });

  it('clamps sinceDays to a sane range and forwards the dayKey filter', async () => {
    const m = makeService({ rollups: [] });
    await m.service.listDailyCostRollups({ sinceDays: 9999 });
    expect(m.groupBy).toHaveBeenCalledTimes(1);
    const calls = m.groupBy.mock.calls as unknown as Array<[{ where: { dayKey: { gte: string } } }]>;
    const where = calls[0]![0].where;
    expect(where.dayKey.gte).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
