/**
 * Mention parsing contract (keep in sync with www `utils/mention-autocomplete.ts`).
 *
 * Username rules:
 * - starts with a letter
 * - then letters/numbers/underscore
 * - max 15 chars total
 *
 * Display parsing rule:
 * - '@' must not be preceded by a word char (avoid emails like foo@bar.com)
 */
export const MENTION_USERNAME_RE_SOURCE = '[A-Za-z][A-Za-z0-9_]{0,14}';

/** Strict mention tokens for display and notifications (email-safe). */
export const MENTION_IN_TEXT_DISPLAY_RE = new RegExp(`(?<![a-zA-Z0-9_])@(${MENTION_USERNAME_RE_SOURCE})`, 'g');

/** Parse unique @username tokens from body (email-safe). */
export function parseMentionsFromBody(body: string): string[] {
  const value = (body ?? '').toString();
  if (!value) return [];
  const re = new RegExp(MENTION_IN_TEXT_DISPLAY_RE.source, 'g');
  const matches = value.matchAll(re);
  return [...new Set([...matches].map((m) => m[1]).filter(Boolean))];
}

