import { resolveSignupAttribution } from './signup-attribution';

describe('resolveSignupAttribution', () => {
  it('prefers src over utm_source and sanitizes tokens', () => {
    const out = resolveSignupAttribution(
      {
        src: ' X-Founder!! ',
        utmSource: 'twitter',
        utmMedium: 'Social',
        utmCampaign: 'Bring_One Man',
        landingPath: '/Bring-One-Man?x=1',
        referrerHost: 'T.co',
      },
      { referralApplied: false },
    );
    expect(out).toEqual({
      signupSource: 'x-founder',
      signupMedium: 'social',
      signupCampaign: 'bring_oneman',
      signupLandingPath: '/bring-one-man',
      signupReferrerHost: 't.co',
    });
  });

  it('falls back to utm_source, then invite when a recruiter applied', () => {
    expect(resolveSignupAttribution({ utmSource: 'Newsletter' }, { referralApplied: true }).signupSource).toBe('newsletter');
    expect(resolveSignupAttribution(null, { referralApplied: true }).signupSource).toBe('invite');
    expect(resolveSignupAttribution(undefined, { referralApplied: false }).signupSource).toBeNull();
  });

  it('caps length and rejects non-path landing values', () => {
    const out = resolveSignupAttribution(
      { src: 'a'.repeat(200), landingPath: 'https://evil.test/x' },
      { referralApplied: false },
    );
    expect(out.signupSource).toHaveLength(64);
    expect(out.signupLandingPath).toBeNull();
  });
});
