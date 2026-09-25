import { formatRetryIn, postRateLimitFor, postRateLimitMessage, REPLY_RATE_LIMIT } from './posts-rate-limit';

const cfg = {
  verifiedPostsPerWindow: 5,
  verifiedWindowSeconds: 300,
  premiumPostsPerWindow: 10,
  premiumWindowSeconds: 300,
};

describe('postRateLimitFor', () => {
  it('gives replies their own generous budget regardless of tier', () => {
    expect(postRateLimitFor({ isReply: true, isPremium: false, cfg })).toEqual({ kind: 'reply', ...REPLY_RATE_LIMIT });
    expect(postRateLimitFor({ isReply: true, isPremium: true, cfg })).toEqual({ kind: 'reply', ...REPLY_RATE_LIMIT });
    expect(REPLY_RATE_LIMIT.postsPerWindow).toBeGreaterThan(cfg.premiumPostsPerWindow);
  });

  it('uses the configured tier limit for top-level posts', () => {
    expect(postRateLimitFor({ isReply: false, isPremium: false, cfg })).toEqual({
      kind: 'post',
      postsPerWindow: 5,
      windowSeconds: 300,
    });
    expect(postRateLimitFor({ isReply: false, isPremium: true, cfg }).postsPerWindow).toBe(10);
  });
});

describe('postRateLimitMessage', () => {
  it('tells the member exactly when they can go again, rounding up', () => {
    expect(formatRetryIn(0.2)).toBe('1 second');
    expect(formatRetryIn(42.1)).toBe('43 seconds');
    expect(formatRetryIn(61)).toBe('2 minutes');
    expect(formatRetryIn(60)).toBe('1 minute');
  });

  it('keeps reply copy short and points top-level posters at replies', () => {
    const reply = postRateLimitFor({ isReply: true, isPremium: false, cfg });
    expect(postRateLimitMessage(reply, 12)).toBe('You’re replying fast. Try again in 12 seconds.');
    const post = postRateLimitFor({ isReply: false, isPremium: false, cfg });
    expect(postRateLimitMessage(post, 150)).toContain('Replies still work');
    expect(postRateLimitMessage(post, 150)).toContain('3 minutes');
  });
});
