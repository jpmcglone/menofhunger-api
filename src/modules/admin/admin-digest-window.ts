import {
  dayIndexEastern,
  easternDayKey,
  easternDayKeyFromDayIndex,
  easternDayStart,
  yesterdayEasternDayKey,
} from '../../common/time/eastern-day-key';

const ET_ZONE = 'America/New_York';

export type AdminDigestActivityWindow = {
  /** Inclusive start: midnight ET of yesterday. */
  windowStart: Date;
  /** Exclusive end: midnight ET of today. */
  windowEnd: Date;
  /** Midnight ET seven calendar days before today (WAU through yesterday). */
  sevenDaysAgo: Date;
  /** Yesterday's Eastern calendar date, e.g. "Friday, September 18". */
  dateLabel: string;
};

/**
 * Activity window for the 8am ET admin digest: yesterday in America/New_York.
 *
 * Do not derive "yesterday" via `Date.UTC(etYear, etMonth, etDay - 1)`. That
 * UTC midnight is still the previous evening in Eastern Time, so Saturday's
 * digest would be labeled Thursday and the counts would span two days.
 */
export function adminDigestActivityWindow(now: Date): AdminDigestActivityWindow {
  const todayKey = easternDayKey(now);
  const yesterdayKey = yesterdayEasternDayKey(now);
  const weekAgoKey = easternDayKeyFromDayIndex(dayIndexEastern(now) - 7);
  const windowStart = easternDayStart(yesterdayKey);
  const windowEnd = easternDayStart(todayKey);
  const sevenDaysAgo = easternDayStart(weekAgoKey);
  const dateLabel = windowStart.toLocaleDateString('en-US', {
    timeZone: ET_ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return { windowStart, windowEnd, sevenDaysAgo, dateLabel };
}
