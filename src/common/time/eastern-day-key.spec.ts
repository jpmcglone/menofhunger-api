import { easternDayKey, yesterdayEasternDayKey } from './eastern-day-key';

describe('eastern-day-key', () => {
  it('yesterdayEasternDayKey matches ET dayKey of ~36 hours ago', () => {
    const now = new Date('2026-02-19T03:30:00.000Z'); // evening ET (safe, non-DST edge)
    const expectedYesterday = easternDayKey(new Date(now.getTime() - 36 * 60 * 60 * 1000));
    expect(yesterdayEasternDayKey(now)).toBe(expectedYesterday);
  });

  it('does not drift by an extra day around UTC midnight', () => {
    // This timestamp is just after UTC midnight but still previous day in ET.
    const now = new Date('2026-02-19T00:30:00.000Z');
    const expectedYesterday = easternDayKey(new Date(now.getTime() - 36 * 60 * 60 * 1000));
    expect(yesterdayEasternDayKey(now)).toBe(expectedYesterday);
  });
});

