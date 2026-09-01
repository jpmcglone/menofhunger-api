import { issueNewsletterUnsubscribeToken, verifyNewsletterUnsubscribeToken } from './newsletter-unsubscribe-token';

describe('newsletter unsubscribe token', () => {
  const secret = 'test-session-hmac-secret-value';

  it('round-trips a valid token', () => {
    const token = issueNewsletterUnsubscribeToken({ userId: 'user-1', secret });
    expect(verifyNewsletterUnsubscribeToken({ token, secret })).toEqual({ userId: 'user-1' });
  });

  it('rejects a tampered token and a bad secret', () => {
    const token = issueNewsletterUnsubscribeToken({ userId: 'user-1', secret });
    expect(verifyNewsletterUnsubscribeToken({ token: `${token}x`, secret })).toBeNull();
    expect(verifyNewsletterUnsubscribeToken({ token, secret: 'other' })).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const token = issueNewsletterUnsubscribeToken({ userId: 'user-1', secret, now, ttlMs: 1000 });
    expect(
      verifyNewsletterUnsubscribeToken({ token, secret, now: new Date(now.getTime() + 2000) }),
    ).toBeNull();
  });
});
