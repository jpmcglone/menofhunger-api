/** Availability for the current Eastern calendar day's check-in. */
export interface CheckinScheduleDto {
  dayKey: string;
  isOpen: boolean;
  /** 5pm ET today, expressed as an ISO UTC timestamp. */
  opensAt: string;
  /** Midnight ET ending today's window, expressed as an ISO UTC timestamp. */
  closesAt: string;
}
