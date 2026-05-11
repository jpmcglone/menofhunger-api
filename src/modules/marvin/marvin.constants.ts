/**
 * Constants for the Marv (AI helper) module. Job names and idempotency-key
 * helpers live here so they're shared between the producer (PostsService /
 * MessagesService) and the consumer (MarvinPublic/PrivateReplyProcessor) without
 * a cyclic import.
 */

import type { MarvinSource } from '@prisma/client';

export const MARV_BOT_TYPE = 'marvin';

/** BullMQ job names for Marv background work. */
export const MARV_JOBS = {
  publicReply: 'marvin.reply.public',
  privateReply: 'marvin.reply.private',
  summarizeThread: 'marvin.summarize-thread',
  refreshContextCards: 'marvin.context-cards.refresh',
  refreshSingleContextCard: 'marvin.context-card.refresh',
  costRollupDaily: 'marvin.cost-rollup.daily',
} as const;

/**
 * Stable idempotency key for a Marv reply request.
 * Format: `marvin:{source}:{sourceId}:{userId}:{messageId}`.
 * Used both as the BullMQ jobId AND inserted into MarvinIdempotencyKey inside the
 * job transaction so a re-enqueue or worker retry never produces a duplicate reply.
 */
export function buildMarvIdempotencyKey(args: {
  source: MarvinSource;
  sourceId: string;
  userId: string;
  messageId: string;
}): string {
  return `marvin:${args.source}:${args.sourceId}:${args.userId}:${args.messageId}`;
}

/**
 * Pre-computed error / no-op codes for `MarvinUsageEvent.errorCode`.
 *
 * Successful AI replies leave `errorCode` null. Every other branch (canned, rate-limited,
 * AI failure) writes one of these so the admin dashboard can show "% of mentions that
 * actually got an AI reply", and per-reason histograms.
 */
export const MARV_ERROR_CODES = {
  notPremium: 'not_premium',
  noCredits: 'no_credits',
  rateLimited: 'rate_limited',
  rateLimitHourly: 'rate_limit_hourly',
  rateLimitDaily: 'rate_limit_daily',
  threadCooldown: 'thread_cooldown',
  contentNotAllowed: 'content_not_allowed',
  aiError: 'ai_error',
  aiNotConfigured: 'ai_not_configured',
  aiNoText: 'ai_no_text',
  disabled: 'disabled',
  disabledForUser: 'disabled_for_user',
  disabledByAdmin: 'disabled_by_admin',
  visibilityNotSupported: 'visibility_not_supported',
  onlyMeVisibility: 'visibility_only_me',
  botUserMissing: 'bot_user_missing',
  postFailed: 'post_failed',
  messageFailed: 'message_failed',
  userBanned: 'user_banned',
} as const;

export type MarvErrorCode = (typeof MARV_ERROR_CODES)[keyof typeof MARV_ERROR_CODES];
