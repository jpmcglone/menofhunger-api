import { buildOnboardingNudgeEmail, pickOnboardingNudge } from './onboarding-nudge';

const base = { verified: true, hasPosted: false, hasCheckedIn: false, hasInvited: false, profileComplete: true, profileReminderSent: false };

describe('pickOnboardingNudge', () => {
  it('asks unverified members to verify at every stage', () => {
    for (const stage of [1, 3, 7] as const) {
      expect(pickOnboardingNudge(stage, { ...base, verified: false })?.ctaPath).toBe('/settings/verification');
    }
  });

  it('picks the next missing step by stage', () => {
    expect(pickOnboardingNudge(1, base)?.headline).toBe('Say hello to the lodge');
    expect(pickOnboardingNudge(3, base)?.headline).toBe('Start a check-in streak');
    expect(pickOnboardingNudge(7, base)?.ctaPath).toBe('/invite');
  });

  it('stays quiet once the step is done', () => {
    expect(pickOnboardingNudge(1, { ...base, hasPosted: true })).toBeNull();
    expect(pickOnboardingNudge(3, { ...base, hasCheckedIn: true })).toBeNull();
    expect(pickOnboardingNudge(7, { ...base, hasInvited: true })).toBeNull();
  });

  it('folds profile help into one stage and does not repeat an old profile reminder', () => {
    expect(pickOnboardingNudge(1, { ...base, profileComplete: false })?.kind).toBe('profile');
    expect(pickOnboardingNudge(7, { ...base, profileComplete: false })?.kind).toBe('profile');
    expect(pickOnboardingNudge(7, { ...base, profileComplete: false, profileReminderSent: true })?.ctaPath).toBe('/invite');
    expect(pickOnboardingNudge(3, { ...base, profileComplete: false })?.ctaPath).toBe('/home');
  });
});

describe('buildOnboardingNudgeEmail', () => {
  it('links to the app and mentions the settings opt-out', () => {
    const nudge = pickOnboardingNudge(7, base)!;
    const email = buildOnboardingNudgeEmail({
      greeting: 'Hey John,',
      nudge,
      baseUrl: 'https://menofhunger.com',
      settingsUrl: 'https://menofhunger.com/settings/notifications',
    });
    expect(email.text).toContain('https://menofhunger.com/invite');
    expect(email.html).toContain('Settings');
  });
});
