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
  const utcMidnight = new Date(dayIndex * 86400000);
  return easternDayKey(utcMidnight);
}

export function yesterdayEasternDayKey(now: Date = new Date()): string {
  return easternDayKeyFromDayIndex(dayIndexEastern(now) - 1);
}

