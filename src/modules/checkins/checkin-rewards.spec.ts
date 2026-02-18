import { computeCheckinRewards } from './checkin-rewards';

describe('computeCheckinRewards', () => {
  it('starts streak at 1 when no last key', () => {
    const out = computeCheckinRewards({
      todayKey: '2026-02-17',
      yesterdayKey: '2026-02-16',
      lastCheckinDayKey: null,
      currentStreakDays: 0,
    });
    expect(out.nextStreakDays).toBe(1);
    expect(out.coinsAdd).toBe(1);
    expect(out.multiplier).toBe(1);
  });

  it('increments streak when last key is yesterday', () => {
    const out = computeCheckinRewards({
      todayKey: '2026-02-17',
      yesterdayKey: '2026-02-16',
      lastCheckinDayKey: '2026-02-16',
      currentStreakDays: 6,
    });
    expect(out.nextStreakDays).toBe(7);
    expect(out.multiplier).toBe(1);
    expect(out.coinsAdd).toBe(1);
  });

  it('awards growing bonus at multiples of 7', () => {
    const day = (n: number) => `2026-02-${String(n).padStart(2, '0')}`;
    const out14 = computeCheckinRewards({
      todayKey: day(14),
      yesterdayKey: day(13),
      lastCheckinDayKey: day(13),
      currentStreakDays: 13,
    });
    expect(out14.nextStreakDays).toBe(14);
    expect(out14.multiplier).toBe(2);
    expect(out14.coinsAdd).toBe(2);
  });

  it('multiplier ramps and caps at 4x', () => {
    const out8 = computeCheckinRewards({
      todayKey: '2026-02-08',
      yesterdayKey: '2026-02-07',
      lastCheckinDayKey: '2026-02-07',
      currentStreakDays: 7,
    });
    expect(out8.nextStreakDays).toBe(8);
    expect(out8.multiplier).toBe(2);
    expect(out8.coinsAdd).toBe(2);

    const out15 = computeCheckinRewards({
      todayKey: '2026-02-15',
      yesterdayKey: '2026-02-14',
      lastCheckinDayKey: '2026-02-14',
      currentStreakDays: 14,
    });
    expect(out15.multiplier).toBe(3);
    expect(out15.coinsAdd).toBe(3);

    const out22 = computeCheckinRewards({
      todayKey: '2026-02-22',
      yesterdayKey: '2026-02-21',
      lastCheckinDayKey: '2026-02-21',
      currentStreakDays: 21,
    });
    expect(out22.multiplier).toBe(4);
    expect(out22.coinsAdd).toBe(4);

    const out100 = computeCheckinRewards({
      todayKey: '2026-04-10',
      yesterdayKey: '2026-04-09',
      lastCheckinDayKey: '2026-04-09',
      currentStreakDays: 99,
    });
    expect(out100.multiplier).toBe(4);
    expect(out100.coinsAdd).toBe(4);
  });

  it('resets streak when last key is not yesterday', () => {
    const out = computeCheckinRewards({
      todayKey: '2026-02-17',
      yesterdayKey: '2026-02-16',
      lastCheckinDayKey: '2026-02-10',
      currentStreakDays: 99,
    });
    expect(out.nextStreakDays).toBe(1);
    expect(out.coinsAdd).toBe(1);
  });

  it('throws a stable error when already checked in today', () => {
    expect(() =>
      computeCheckinRewards({
        todayKey: '2026-02-17',
        yesterdayKey: '2026-02-16',
        lastCheckinDayKey: '2026-02-17',
        currentStreakDays: 3,
      }),
    ).toThrow('already_checked_in_today');
  });
});

