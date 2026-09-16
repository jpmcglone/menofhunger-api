import { HttpException } from '@nestjs/common';

/** Bounded metadata only: never persist an exception's prompt, request body, URL, or credentials. */
export function marvinFailureReason(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const code = typeof response === 'object' && response !== null && 'error' in response ? response.error : null;
    if (code === 'ai_consent_required') return 'ai_consent_required';
    const knownMessages: Record<string, string> = {
      'Posts are limited to 500 characters.': 'post_too_long_500',
      'Posts are limited to 1000 characters.': 'post_too_long_1000',
      'Join this group to reply in this thread.': 'group_membership_required',
      'Upgrade to premium to view premium-only posts.': 'premium_required',
      'Verify to view verified-only posts.': 'verification_required',
      'You cannot reply to this post.': 'blocked',
      'You cannot message this user.': 'blocked',
      'Post not found.': 'post_missing',
      'Invalid Marv reply author.': 'invalid_bot_identity',
    };
    return knownMessages[error.message] ?? `http_${error.getStatus()}`;
  }
  if (error instanceof Error && ['AbortError', 'TimeoutError', 'APIConnectionTimeoutError'].includes(error.name)) return 'timeout';
  if (error instanceof Error && error.message === 'Marv message delivery was refused.') return 'delivery_refused';
  if (typeof error === 'object' && error !== null) {
    const details = error as { status?: unknown; code?: unknown };
    if (typeof details.status === 'number' && Number.isInteger(details.status) && details.status >= 400 && details.status <= 599) return `upstream_${details.status}`;
    if (typeof details.code === 'string' && /^P\d{4}$/.test(details.code)) return `database_${details.code}`;
  }
  return 'unexpected_error';
}

/** Reply posts have a fixed server limit regardless of the bot account's billing state. */
export function fitMarvinPost(text: string): string {
  const cleaned = text.trim();
  if (cleaned.length <= 1000) return cleaned;
  // Preserve complete words (including links) and do not split an emoji surrogate pair.
  const prefix = cleaned.slice(0, 999);
  const boundary = prefix.search(/\s+\S*$/u);
  const end = boundary > 0 ? boundary : /[\uD800-\uDBFF]$/.test(prefix) ? prefix.length - 1 : prefix.length;
  return `${prefix.slice(0, end).trimEnd()}…`;
}
