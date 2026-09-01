import {
  isOneClickUnsubscribePath,
  newsletterListId,
  oneClickUnsubscribeUrl,
  tokenFromUnsubscribeRequest,
} from './email-unsubscribe.helpers';

describe('email unsubscribe helpers', () => {
  it('reads the token from JSON for the website page', () => {
    expect(tokenFromUnsubscribeRequest(undefined, { token: 'abc' })).toBe('abc');
  });

  it('reads the token from the query when Gmail posts One-Click', () => {
    expect(tokenFromUnsubscribeRequest('abc', 'List-Unsubscribe=One-Click')).toBe('abc');
    expect(tokenFromUnsubscribeRequest('abc', { 'List-Unsubscribe': 'One-Click' })).toBe('abc');
  });

  it('matches the public unsubscribe path with or without /v1', () => {
    expect(isOneClickUnsubscribePath('/v1/email/unsubscribe?token=x')).toBe(true);
    expect(isOneClickUnsubscribePath('/email/unsubscribe')).toBe(true);
    expect(isOneClickUnsubscribePath('/v1/notifications')).toBe(false);
  });

  it('builds Gmail list headers from the public API and site host', () => {
    expect(oneClickUnsubscribeUrl('https://api.menofhunger.com/v1', 'tok')).toBe(
      'https://api.menofhunger.com/v1/email/unsubscribe?token=tok',
    );
    expect(newsletterListId('https://menofhunger.com')).toBe(
      'Men of Hunger Newsletter <newsletter.menofhunger.com>',
    );
  });
});
