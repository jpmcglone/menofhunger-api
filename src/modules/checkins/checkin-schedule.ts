import type { CheckinScheduleDto } from './checkin-schedule.dto';
import { easternDayKey, easternMinuteOfDay, etLocalToUtcMs, dayIndexEastern } from '../../common/time/eastern-day-key';

export const CHECKIN_OPENS_MINUTE = 17 * 60;
export const CHECKIN_CLOSED_MESSAGE = 'Check-ins open at 5pm ET. Answer daily from 5pm–11:59pm ET.';

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
