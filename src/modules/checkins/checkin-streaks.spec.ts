import { computeCheckinStreakStats } from './checkin-streaks';

describe('computeCheckinStreakStats', () => {
  it('returns zeros when there are no post days', () => {
    const out = computeCheckinStreakStats({
      dayKeys: [],
      todayKey: '2026-03-06',
      yesterdayKey: '2026-03-05',
    });
    expect(out).toEqual({
      currentStreakDays: 0,
      longestStreakDays: 0,
      lastCheckinDayKey: null,
    });
  });

  it('computes longest from full history and current from tail', () => {
    const out = computeCheckinStreakStats({
      dayKeys: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05', '2026-03-06'],
      todayKey: '2026-03-06',
      yesterdayKey: '2026-03-05',
    });
    expect(out.currentStreakDays).toBe(2);
    expect(out.longestStreakDays).toBe(3);
    expect(out.lastCheckinDayKey).toBe('2026-03-06');
  });

  it('zeroes current streak when last day is older than yesterday', () => {
    const out = computeCheckinStreakStats({
      dayKeys: ['2026-02-20', '2026-02-21', '2026-02-22'],
      todayKey: '2026-03-06',
      yesterdayKey: '2026-03-05',
    });
    expect(out.currentStreakDays).toBe(0);
    expect(out.longestStreakDays).toBe(3);
    expect(out.lastCheckinDayKey).toBe('2026-02-22');
  });
});
