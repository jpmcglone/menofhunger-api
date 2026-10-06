import type { NotificationKind } from '@prisma/client';

export const BELL_EXCLUDED_KINDS: NotificationKind[] = ['message', 'community_group_post'];

/**
 * Person-accountability surfaces. Pages inherit operator premium, so they would
 * otherwise get "have you checked in?" and daily-content bells. Operators already
 * receive those on the person account — the page inbox should stay about the page.
 */
export const PERSON_ONLY_NOTIFICATION_KINDS: NotificationKind[] = [
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
  'checkin_post',
  'nudge',
];

export function bellExcludedKindsForAccount(
  accountKind?: string | null,
): NotificationKind[] {
  return accountKind === 'page'
    ? [...BELL_EXCLUDED_KINDS, ...PERSON_ONLY_NOTIFICATION_KINDS]
    : BELL_EXCLUDED_KINDS;
}

