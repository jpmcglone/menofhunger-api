import { scrubSentryEvent } from './sentry-scrub';

describe('scrubSentryEvent', () => {
  it('drops bodies and cookies and redacts credential headers', () => {
    const event = scrubSentryEvent({
      request: {
        data: { phone: '+15555550100', code: '123456' },
        cookies: { moh_session: 'secret' },
        headers: { Cookie: 'moh_session=secret', Authorization: 'Bearer x', 'User-Agent': 'ios' },
      },
    });

    expect(event.request).toEqual({
      headers: { Cookie: '[REDACTED]', Authorization: '[REDACTED]', 'User-Agent': 'ios' },
    });
  });

  it('redacts sensitive query parameters and keeps harmless ones', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.menofhunger.com/v1/auth/callback?code=abc&limit=20',
        query_string: 'access_token=abc&cursor=next',
      },
      breadcrumbs: [{ category: 'http', data: { url: '/v1/x?token=abc&page=2' } }],
    });

    expect(event.request.url).toBe('https://api.menofhunger.com/v1/auth/callback?code=%5BREDACTED%5D&limit=20');
    expect(event.request.query_string).toBe('access_token=%5BREDACTED%5D&cursor=next');
    expect(event.breadcrumbs[0].data.url).toBe('/v1/x?token=%5BREDACTED%5D&page=2');
  });

  it('keeps only the member id on the user', () => {
    const event = scrubSentryEvent({ user: { id: 'user_1', ip_address: '1.2.3.4', email: 'a@b.c' } });

    expect(event.user).toEqual({ id: 'user_1' });
  });
});
