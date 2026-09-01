import { etLocalToUtcMs } from '../../common/time/eastern-day-key';

describe('space schedule reminder timing', () => {
  it('computes 09:00 ET on the scheduled calendar day', () => {
    // Friday Aug 14 2026 20:00 ET = 2026-08-15T00:00:00.000Z (EDT)
    const scheduledAt = new Date('2026-08-15T00:00:00.000Z');
    const dayAt = etLocalToUtcMs(scheduledAt, 9, 0);
    // 09:00 EDT on Aug 14 = 13:00 UTC
    expect(new Date(dayAt).toISOString()).toBe('2026-08-14T13:00:00.000Z');
  });

  it('places the 30-minute reminder before start', () => {
    const scheduledAtMs = Date.parse('2026-08-15T00:00:00.000Z');
    const soonAt = scheduledAtMs - 30 * 60 * 1000;
    expect(new Date(soonAt).toISOString()).toBe('2026-08-14T23:30:00.000Z');
  });
});
