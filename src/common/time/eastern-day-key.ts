const ET_ZONE = 'America/New_York';

function easternParts(d: Date): { yyyy: number; mm: number; dd: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { yyyy: get('year'), mm: get('month'), dd: get('day') };
}

function easternHm(d: Date): { hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hhRaw = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return {
    hh: ((hhRaw % 24) + 24) % 24,
    mm: Number(parts.find((p) => p.type === 'minute')?.value ?? 0),
  };
}

export function easternDayKey(d: Date): string {
  const p = easternParts(d);
  const yyyy = String(p.yyyy).padStart(4, '0');
  const mm = String(p.mm).padStart(2, '0');
  const dd = String(p.dd).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Day number for the calendar day in Eastern Time (stable across DST). */
export function dayIndexEastern(d: Date): number {
  const p = easternParts(d);
  // Date.UTC expects month 0-11.
  return Math.floor(Date.UTC(p.yyyy, p.mm - 1, p.dd) / 86400000);
}

export function easternDayKeyFromDayIndex(dayIndex: number): string {
  // Use UTC noon so the corresponding Eastern Time date is stable.
  // (UTC midnight can fall on the previous ET calendar day.)
  const utcNoon = new Date(dayIndex * 86400000 + 12 * 60 * 60 * 1000);
  return easternDayKey(utcNoon);
}

export function yesterdayEasternDayKey(now: Date = new Date()): string {
  return easternDayKeyFromDayIndex(dayIndexEastern(now) - 1);
}

/** Minutes elapsed since midnight ET for the given instant. */
export function easternMinuteOfDay(d: Date): number {
  const { hh, mm } = easternHm(d);
  return hh * 60 + mm;
}

/**
 * The ET day key whose word-of-the-day is currently active.
 * Today's key if ET >= 09:00; yesterday's key before that.
 */
export function wordContentDayKey(d: Date): string {
  return easternMinuteOfDay(d) >= 9 * 60 ? easternDayKey(d) : yesterdayEasternDayKey(d);
}

/**
 * The ET day key whose quote-of-the-day is currently active.
 * Today's key if ET >= 09:30; yesterday's key before that.
 */
export function quoteContentDayKey(d: Date): string {
  return easternMinuteOfDay(d) >= 9 * 60 + 30 ? easternDayKey(d) : yesterdayEasternDayKey(d);
}

/**
 * Convert a dayKey (YYYY-MM-DD) to a Date that falls on that ET calendar date.
 * Uses UTC noon on the ISO date, which always maps to the correct ET day
 * (ET is UTC-4 or UTC-5, so UTC noon = 7–8am ET = same calendar day).
 */
export function dayKeyToDate(dayKey: string): Date {
  const [y, m, day] = (dayKey ?? '').split('-').map(Number);
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, day ?? 1, 12, 0, 0));
}

/**
 * UTC ms of the next daily-content publish boundary.
 *
 * Boundaries (ET):
 *   09:00 — word of the day
 *   09:30 — quote of the day
 *
 * If both are past for today, the next boundary is 09:00 ET tomorrow.
 */
export function nextPublishBoundaryUtcMs(now: Date): number {
  const min = easternMinuteOfDay(now);
  if (min < 9 * 60) {
    return etLocalToUtcMs(now, 9, 0);
  }
  if (min < 9 * 60 + 30) {
    return etLocalToUtcMs(now, 9, 30);
  }
  // Both published today; next is 09:00 ET tomorrow.
  const tomorrowUtc = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return etLocalToUtcMs(tomorrowUtc, 9, 0);
}

/**
 * UTC ms of when the next word-of-the-day will publish (09:00 ET).
 * If 09:00 ET today has already passed, returns 09:00 ET tomorrow.
 */
export function nextWordPublishUtcMs(now: Date): number {
  const min = easternMinuteOfDay(now);
  if (min < 9 * 60) {
    return etLocalToUtcMs(now, 9, 0);
  }
  const tomorrowUtc = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return etLocalToUtcMs(tomorrowUtc, 9, 0);
}

/**
 * UTC ms of when the next quote-of-the-day will publish (09:30 ET).
 * If 09:30 ET today has already passed, returns 09:30 ET tomorrow.
 */
export function nextQuotePublishUtcMs(now: Date): number {
  const min = easternMinuteOfDay(now);
  if (min < 9 * 60 + 30) {
    return etLocalToUtcMs(now, 9, 30);
  }
  const tomorrowUtc = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return etLocalToUtcMs(tomorrowUtc, 9, 30);
}

/**
 * Find the UTC timestamp corresponding to hh:mm ET on the ET calendar date of `ref`.
 * Scans UTC hours (DST-safe).
 */
function etLocalToUtcMs(ref: Date, hh: number, mm: number): number {
  const { yyyy, mm: etMm, dd } = easternParts(ref);
  for (let utcH = 0; utcH <= 23; utcH++) {
    const cand = new Date(Date.UTC(yyyy, etMm - 1, dd, utcH, mm, 0));
    const p = easternHm(cand);
    if (p.hh === hh && p.mm === mm) return cand.getTime();
  }
  // DST edge: try +1 day
  const next = new Date(Date.UTC(yyyy, etMm - 1, dd + 1, 0, mm, 0));
  const np = easternHm(next);
  if (np.hh === hh && np.mm === mm) return next.getTime();
  return ref.getTime() + 60 * 60 * 1000;
}
