import type { CheckinScheduleDto } from './checkin-schedule.dto';
import { easternDayKey, easternMinuteOfDay, etLocalToUtcMs, dayIndexEastern } from '../../common/time/eastern-day-key';

export const CHECKIN_OPENS_MINUTE = 17 * 60;
export const CHECKIN_CLOSED_MESSAGE = 'Check-ins open at 5pm ET. Answer daily from 5pm–11:59pm ET.';

/** Evening check-in reminder (bell + push + streak email) — 8:00pm ET. */
export const CHECKIN_REMINDER_MINUTE = 20 * 60;

/** On This Day fan-out window: 8:00am–noon ET. */
export const ON_THIS_DAY_OPENS_MINUTE = 8 * 60;
export const ON_THIS_DAY_CLOSES_MINUTE = 12 * 60;

/** Nightly streak reset — 1:00am ET. Crew-broken push waits until morning. */
export const STREAK_RESET_MINUTE = 60;
export const CREW_STREAK_BROKEN_PUSH_MINUTE = 8 * 60;
export const CREW_STREAK_BROKEN_PUSH_CLOSES_MINUTE = 12 * 60;

/**
 * Delay from `now` until 8:00am ET the same Eastern morning.
 * Returns null after noon ET so a late reset does not blast in the afternoon.
 */
export function crewStreakBrokenPushDelayMs(now: Date): number | null {
  if (easternMinuteOfDay(now) >= CREW_STREAK_BROKEN_PUSH_CLOSES_MINUTE) return null;
  return Math.max(0, etLocalToUtcMs(now, 8, 0) - now.getTime());
}

export function checkinReminderBody(streakDays: number): string {
  const n = Math.max(1, Math.floor(streakDays));
  return `Answer today’s prompt before midnight ET to keep your ${n}-day streak alive.`;
}

export function isCheckinOpen(now: Date): boolean {
  return easternMinuteOfDay(now) >= CHECKIN_OPENS_MINUTE;
}

export function checkinSchedule(now: Date): CheckinScheduleDto {
  // Calendar arithmetic at UTC noon keeps tomorrow correct across DST changes.
  const tomorrow = new Date((dayIndexEastern(now) + 1) * 86_400_000 + 12 * 60 * 60 * 1000);
  return {
    isOpen: isCheckinOpen(now),
    opensAt: new Date(etLocalToUtcMs(now, 17, 0)).toISOString(),
    closesAt: new Date(etLocalToUtcMs(tomorrow, 0, 0)).toISOString(),
    dayKey: easternDayKey(now),
  };
}
