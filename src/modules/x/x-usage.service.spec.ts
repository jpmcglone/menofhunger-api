import { xMonth, xMonthlyAllowance, XUsageService } from './x-usage.service';

describe('X monthly allowances', () => {
  const now = new Date('2030-12-31T23:59:59.999Z');
  it('requires verification even with Premium', () => {
    expect(xMonthlyAllowance(false, true, 0, 0, now)).toMatchObject({ totalLimit: 0, linkLimit: 0 });
  });
  it('offers 50/3 and 300/20 with upgrade and downgrade usage retained', () => {
    expect(xMonthlyAllowance(true, false, 49, 2, now)).toMatchObject({ totalRemaining: 1, linkRemaining: 1 });
    expect(xMonthlyAllowance(true, true, 49, 2, now)).toMatchObject({ totalRemaining: 251, linkRemaining: 18 });
    expect(xMonthlyAllowance(true, false, 51, 4, now)).toMatchObject({ totalRemaining: 0, linkRemaining: 0 });
  });
  it('uses UTC calendar months including year rollover', () => {
    expect(xMonth(now).toISOString()).toBe('2030-12-01T00:00:00.000Z');
    expect(xMonthlyAllowance(true, false, 0, 0, now).resetsAt).toBe('2031-01-01T00:00:00.000Z');
  });
  it('counts both the page and external identity and holds uncertain usage', async () => {
    const findMany = jest.fn().mockResolvedValue([{ hasLink: true }, { hasLink: false }]);
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ verifiedStatus: 'manual', premium: true }) }, xUsageReservation: { findMany } };
    const service = new XUsageService(prisma as any);
    expect(await service.allowance('page', 'external', now)).toMatchObject({ totalRemaining: 298, linkRemaining: 19 });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ status: { not: 'released' }, OR: [{ userId: 'page' }, { externalAccountId: 'external' }] });
  });
});
