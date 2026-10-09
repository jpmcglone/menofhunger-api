import type { NotificationKind } from '@prisma/client';

export type PushActorContext = {
  id: string;
  username: string | null;
  name: string | null;
  avatarKey: string | null; avatarVideoKey?: string | null; avatarVideoDurationMs?: number | null;
  /** Accepts a Date or an ISO string — publicAssetUrl handles both. */
  avatarUpdatedAt: Date | string | null;
};

/** Coalesce window (ms) per push kind to reduce fatigue. */
export const PUSH_COALESCE_MS: Partial<Record<string, number>> = {
  nudge: 15 * 60 * 1000,
  followed_post: 5 * 60 * 1000,
  status_update: 5 * 60 * 1000,
  repost: 2 * 60 * 1000,
  message: 30 * 1000,
};
export const DEFAULT_COALESCE_MS = 60 * 1000;

/** Sentence-case a short action phrase for lock-screen subtitles ("checked in" → "Checked in"). */
export function sentenceCaseAction(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Lock-screen action lines read as a label before the preview: "Checked in:". */
export function withActionColon(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return /[:.!?]$/.test(text) ? text : `${text}:`;
}

/**
 * System / non-actor pushes. Their `fallbackTitle` IS the alert title — never reuse it
 * as subtitle (that produces "Good morning" / "Good morning" on lock screen).
 */
export const SYSTEM_PUSH_KINDS = new Set<NotificationKind>([
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
  'account_verified',
  'premium_started',
  'premium_ended',
  'poll_results_ready',
  'space_reminder_day',
  'space_reminder_soon',
  'space_live',
  'space_schedule_cancelled',
  'space_schedule_rescheduled',
]);

/**
 * Prefer a concrete group name over generic "their/your/the/a group" phrasing
 * so Communication-style pushes still name the group after the title becomes the actor.
 */
export function actionWithGroupName(action: string, groupName: string): string {
  const replaced = action
    .replace(/\btheir group\b/i, groupName)
    .replace(/\byour group\b/i, groupName)
    .replace(/\bthe group\b/i, groupName)
    .replace(/\ba group\b/i, groupName);
  return replaced;
}

/** Person-accountability pushes. Pages inherit operator premium and would otherwise get these on the operator's phone. */
export const PERSON_ONLY_PUSH_KINDS = new Set<NotificationKind>([
  'word_of_the_day',
  'quote_of_the_day',
  'checkin_reminder',
  'on_this_day',
  'checkin_post',
  'nudge',
]);
