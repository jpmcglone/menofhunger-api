import {
  easternDayKey,
  easternWeekDayKeys,
  yesterdayEasternDayKey,
  wordContentDayKey,
  quoteContentDayKey,
  nextPublishBoundaryUtcMs,
} from './eastern-day-key';

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

describe('wordContentDayKey / quoteContentDayKey publish boundaries', () => {
  // 2026-07-15 is summer (EDT = UTC-4). UTC 12:58 = 08:58 ET (before both boundaries).
  const before09 = new Date('2026-07-15T12:58:00.000Z'); // 08:58 ET
  const at09 = new Date('2026-07-15T13:00:00.000Z');     // 09:00 ET
  const at0915 = new Date('2026-07-15T13:15:00.000Z');   // 09:15 ET
  const at0930 = new Date('2026-07-15T13:30:00.000Z');   // 09:30 ET
  const after0930 = new Date('2026-07-15T13:31:00.000Z'); // 09:31 ET

  describe('wordContentDayKey', () => {
    it('returns yesterday before 09:00 ET', () => {
      const key = wordContentDayKey(before09);
      expect(key).toBe('2026-07-14');
    });

    it('returns today at exactly 09:00 ET', () => {
      expect(wordContentDayKey(at09)).toBe('2026-07-15');
    });

    it('returns today between 09:00 and 09:30 ET', () => {
      expect(wordContentDayKey(at0915)).toBe('2026-07-15');
    });

    it('returns today after 09:30 ET', () => {
      expect(wordContentDayKey(after0930)).toBe('2026-07-15');
    });
  });

  describe('quoteContentDayKey', () => {
    it('returns yesterday before 09:30 ET', () => {
      expect(quoteContentDayKey(at0915)).toBe('2026-07-14');
    });

    it('returns today at exactly 09:30 ET', () => {
      expect(quoteContentDayKey(at0930)).toBe('2026-07-15');
    });

    it('returns today after 09:30 ET', () => {
      expect(quoteContentDayKey(after0930)).toBe('2026-07-15');
    });
  });

  describe('during DST transition (spring-forward 2026-03-08, clocks spring at 02:00 ET)', () => {
    // On DST day there is no 02:00-02:59 ET; 09:00 ET is still well-defined.
    // UTC 13:00 on 2026-03-08 = 09:00 EDT.
    const dstAt09 = new Date('2026-03-08T14:00:00.000Z'); // 09:00 EST was 14:00 UTC before DST, but after DST 09:00 EDT = 13:00 UTC
    it('wordContentDayKey returns today at 09:00 on DST day', () => {
      // At 14:00 UTC on 2026-03-08 (after spring-forward) it's 10:00 EDT — today
      expect(wordContentDayKey(dstAt09)).toBe('2026-03-08');
    });
  });
});

describe('easternWeekDayKeys', () => {
  it('stays on the ET Saturday week after UTC has rolled to Sunday', () => {
    // Saturday 2026-08-29 21:20 ET = Sunday 01:20 UTC.
    const afterUtcMidnight = new Date('2026-08-30T01:20:00.000Z');
    expect(easternWeekDayKeys(afterUtcMidnight)).toEqual([
      '2026-08-23',
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
    ]);
  });

  it('uses the same ET week earlier the same Saturday', () => {
    const afternoonEt = new Date('2026-08-29T19:00:00.000Z'); // 15:00 EDT
    expect(easternWeekDayKeys(afternoonEt)[0]).toBe('2026-08-23');
    expect(easternWeekDayKeys(afternoonEt)[6]).toBe('2026-08-29');
  });

  it('opens a new week at Sunday midnight ET', () => {
    const sundayMorningEt = new Date('2026-08-30T08:00:00.000Z'); // 04:00 EDT Sunday
    expect(easternWeekDayKeys(sundayMorningEt)[0]).toBe('2026-08-30');
    expect(easternWeekDayKeys(sundayMorningEt)[6]).toBe('2026-09-05');
  });
});

describe('nextPublishBoundaryUtcMs', () => {
  it('returns 09:00 ET boundary when before 09:00', () => {
    const before = new Date('2026-07-15T12:58:00.000Z'); // 08:58 EDT
    const boundary = nextPublishBoundaryUtcMs(before);
    const boundaryDate = new Date(boundary);
    // 09:00 EDT = 13:00 UTC on 2026-07-15
    expect(boundaryDate.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('returns 09:30 ET boundary when between 09:00 and 09:30', () => {
    const between = new Date('2026-07-15T13:15:00.000Z'); // 09:15 EDT
    const boundary = nextPublishBoundaryUtcMs(between);
    const boundaryDate = new Date(boundary);
    // 09:30 EDT = 13:30 UTC
    expect(boundaryDate.toISOString()).toBe('2026-07-15T13:30:00.000Z');
  });

  it('returns next-day 09:00 ET boundary when after 09:30', () => {
    const after = new Date('2026-07-15T13:31:00.000Z'); // 09:31 EDT
    const boundary = nextPublishBoundaryUtcMs(after);
    const boundaryDate = new Date(boundary);
    // Next day 09:00 EDT = 2026-07-16T13:00:00Z
    expect(boundaryDate.toISOString()).toBe('2026-07-16T13:00:00.000Z');
  });
});

