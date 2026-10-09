import { buildLifecycleEmail, type LifecycleEmailKind } from './email-content-lifecycle';

const base = { greeting: 'Hey John,', url: 'https://menofhunger.com/home', settingsUrl: 'https://menofhunger.com/settings/notifications' };

describe('lifecycle email content', () => {
  it.each<LifecycleEmailKind>(['verified', 'premium', 'referralReward', 'grantExpiring', 'cancellation', 'paymentAttention', 'accountChanged', 'verificationAction', 'premiumTip'])(
    '%s has an accessible heading, a meaningful preview, and matching plain-text destination', kind => {
      const email = buildLifecycleEmail({ ...base, kind });
      expect(email.html).toContain('<html lang="en"');
      expect(email.html).toContain('<h1');
      expect(email.html).toContain('href="https://menofhunger.com/home"');
      expect(email.text).toContain(base.url);
      expect(email.subject.length).toBeGreaterThan(10);
      expect(email.text.split(/\s+/).length).toBeLessThan(200);
    },
  );

  it('combines verification with referral Premium without suggesting a purchase', () => {
    const email = buildLifecycleEmail({ ...base, kind: 'premium', verified: true, source: 'referral', tier: 'premium', accessTerms: 'ends', expiresAt: '2026-11-10T17:00:00Z' });
    expect(email.subject).toBe('You’re verified—and Premium is ready.');
    expect(email.text).toContain('Your referral reward');
    expect(email.text).toContain('November 10, 2026');
    expect(email.text).not.toMatch(/payment|charged|will renew|next renewal/i);
    expect(email.text).not.toMatch(/Dialogues|workshops|facilitated|Steward calls/i);
  });

  it('uses actual renewal terms and Apple management for paid access', () => {
    const email = buildLifecycleEmail({ ...base, kind: 'premium', source: 'apple', tier: 'premiumPlus', accessTerms: 'renews', expiresAt: '2026-11-10T17:00:00Z', billingUrl: 'https://apps.apple.com/account/subscriptions' });
    expect(email.text).toContain('Your next renewal is November 10, 2026');
    expect(email.text).toContain('Manage your subscription through Apple');
    expect(email.text).toContain('https://apps.apple.com/account/subscriptions');
    expect(email.subject).toContain('Premium+');
  });

  it('does not invent a payment deadline or render invalid dates', () => {
    const email = buildLifecycleEmail({ ...base, kind: 'paymentAttention', expiresAt: 'not-a-date', paymentDeadline: null });
    expect(email.text).not.toContain('Invalid Date');
    expect(email.text).not.toContain('Please resolve it by');
    expect(email.text).toContain('current status');
  });

  it('escapes recipient content in HTML while preserving plain text', () => {
    const email = buildLifecycleEmail({ ...base, kind: 'referralReward', greeting: 'Hey <script>alert(1)</script>,', rewardName: '<img src=x onerror=alert(1)>' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('keeps verification decisions and account identifiers out of email', () => {
    const verification = buildLifecycleEmail({ ...base, kind: 'verificationAction' });
    expect(verification.text).toContain('verification page');
    const security = buildLifecycleEmail({ ...base, kind: 'accountChanged', changedField: 'phone', occurredAt: '2026-10-09T21:00:00Z' });
    expect(security.text).toContain('login phone number');
    expect(security.text).toContain('5:00 PM EDT');
    expect(security.text).toContain('If this wasn’t you');
  });
});
