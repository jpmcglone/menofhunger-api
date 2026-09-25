import type { SiteConfigRow } from '../site-config/site-config.service';

export type PostRateLimit = {
  kind: 'post' | 'reply';
  postsPerWindow: number;
  windowSeconds: number;
};

/**
 * Replies (feed replies and Board comments) are conversation, not broadcast: they get their own
 * generous burst guard so a live back-and-forth never trips the top-level limit. The two budgets
 * are counted separately, so replying never spends someone's top-level posts either.
 */
export const REPLY_RATE_LIMIT = { postsPerWindow: 30, windowSeconds: 5 * 60 } as const;

export function postRateLimitFor(params: {
  isReply: boolean;
  isPremium: boolean;
  cfg: Pick<
    SiteConfigRow,
    'verifiedPostsPerWindow' | 'verifiedWindowSeconds' | 'premiumPostsPerWindow' | 'premiumWindowSeconds'
  >;
}): PostRateLimit {
  if (params.isReply) return { kind: 'reply', ...REPLY_RATE_LIMIT };
  const { cfg, isPremium } = params;
  return {
    kind: 'post',
    postsPerWindow: isPremium ? cfg.premiumPostsPerWindow : cfg.verifiedPostsPerWindow,
    windowSeconds: isPremium ? cfg.premiumWindowSeconds : cfg.verifiedWindowSeconds,
  };
}

/** Human wait time, rounded up so "try again" is never early. */
export function formatRetryIn(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return s === 1 ? '1 second' : `${s} seconds`;
  const minutes = Math.ceil(s / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function postRateLimitMessage(limit: PostRateLimit, retryInSeconds: number): string {
  const wait = formatRetryIn(retryInSeconds);
  if (limit.kind === 'reply') return `You’re replying fast. Try again in ${wait}.`;
  return `You’ve hit the limit of ${limit.postsPerWindow} posts for now. Replies still work — try posting again in ${wait}.`;
}
