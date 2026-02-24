export type AdminEmailSampleTypeDto =
  | 'daily_digest'
  | 'weekly_digest'
  | 'new_notifications'
  | 'instant_high_signal'
  | 'streak_reminder';

export type AdminEmailSampleSendResultDto = {
  sent: boolean;
  reason: string | null;
  type: AdminEmailSampleTypeDto;
};

