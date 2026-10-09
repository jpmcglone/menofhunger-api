import type { EmailSendRequest } from './providers/email-provider';

export const EMAIL_PREFERENCES = [
  'emailDigestWeekly', 'emailNewNotifications', 'emailInstantHighSignal',
  'emailStreakReminder', 'emailFollowedArticle', 'emailOnboarding', 'emailNewsletter',
] as const;
export type EmailPreference = (typeof EMAIL_PREFERENCES)[number];
export type EmailCategory = 'transactional' | 'service' | 'engagement' | 'broadcast';
export type SendEmailParams = EmailSendRequest & {
  category?: EmailCategory;
  userId?: string;
  eventKey?: string;
  preference?: EmailPreference;
  /** Public, permission-independent notices only. Private content is never replayed later. */
  retrySafe?: boolean;
  /** Email-address change security notice sent to the previous verified address. */
  recipientMode?: 'current' | 'previous' | 'verification';
};
